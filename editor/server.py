"""Local print export service for Prism.

Each request supplies a frozen artwork snapshot and aligned black-on-white
process masks. The service emits real technical separations, without claiming
printer-specific colour accuracy or PDF/X conformance.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import io
import json
import math
import mimetypes
import threading
import sqlite3
import warnings
import zipfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from project_store import ProjectStore, ProjectError, PROJECT_ID
from urllib.parse import unquote, urlsplit

import numpy as np
from PIL import Image, UnidentifiedImageError
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject,
    NameObject, NumberObject, RectangleObject,
)
from reportlab.lib.colors import CMYKColorSep
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas


MAX_PROJECT_REQUEST_BYTES = 150 * 1024 * 1024
MAX_REQUEST_BYTES = 120 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 24_000_000
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
EXPORT_SLOTS = threading.BoundedSemaphore(2)
PRINT_ENGINE = 'prism-print/1.0'
DIST_DIRECTORY = Path(__file__).resolve().parent / 'dist'
SPOT_PROFILES = {
    'standard': {'white': 'White', 'foil': 'Foil_Gold', 'clear': 'Spot_UV'},
    'alternate': {'white': 'OPW', 'foil': 'FOIL', 'clear': 'CLEAR'},
}
ALTERNATES = {
    'white': (0, 0, 0, 0),
    'foil': (0, 0.3, 0.85, 0.1),
    'clear': (0, 0, 0, 0),
}
PLATE_LABELS = {'white': '白墨', 'foil': '箔', 'clear': '光油'}


class ExportError(ValueError):
    """A user-correctable invalid request."""


def numeric(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ExportError(f'{name}必须是数字')
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise ExportError(f'{name}须在 {minimum}–{maximum} 之间')
    return float(value)


def decode_image(value, label):
    if not isinstance(value, str) or not value.startswith('data:image/png;base64,'):
        raise ExportError(f'{label}须为 PNG 数据')
    encoded = value.partition(',')[2]
    if len(encoded) > MAX_IMAGE_BYTES * 4 // 3 + 4:
        raise ExportError(f'{label}超过 20 MB')
    try:
        raw = base64.b64decode(encoded, validate=True)
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                if source.format != 'PNG':
                    raise ExportError(f'{label}的内容不是 PNG')
                if source.width * source.height > MAX_IMAGE_PIXELS:
                    raise ExportError(f'{label}超过 2400 万像素')
                if source.width < 32 or source.height < 32:
                    raise ExportError(f'{label}的尺寸过小')
                source.load()
                rgba = source.convert('RGBA')
                background = Image.new('RGBA', source.size, 'white')
                return Image.alpha_composite(background, rgba).convert('RGB')
    except (binascii.Error, UnidentifiedImageError, OSError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise ExportError(f'{label}无法读取，请重新导出图片') from error


def validate_request(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get('project'), dict):
        raise ExportError('缺少项目数据')
    profile = payload.get('profile', 'standard')
    if not isinstance(profile, str) or profile not in SPOT_PROFILES:
        raise ExportError('未知的输出配置')
    source = payload['project']
    name = source.get('name', '未命名卡牌')
    project_id = source.get('id', '')
    if not isinstance(name, str) or not isinstance(project_id, str):
        raise ExportError('项目名称与标识须为文字')
    project = {
        'id': project_id[:200], 'name': name[:200],
        'version': numeric(source.get('version', 1), '版本', 0, 1_000_000_000),
        'widthMm': numeric(source.get('widthMm'), '宽度', 20, 300),
        'heightMm': numeric(source.get('heightMm'), '高度', 20, 300),
        'bleedMm': numeric(source.get('bleedMm', 3), '出血', 0, 20),
        'material': str(source.get('material', '未指定'))[:200],
    }
    raw_pages = payload.get('pages')
    if not isinstance(raw_pages, list) or not 1 <= len(raw_pages) <= 2:
        raise ExportError('请选择一面或正反两面')
    pages = []
    sides = set()
    common_size = None
    for raw_page in raw_pages:
        if not isinstance(raw_page, dict):
            raise ExportError('卡面数据无效')
        side = raw_page.get('side')
        if not isinstance(side, str) or side not in ('front', 'back') or side in sides:
            raise ExportError('卡面必须是唯一的 front 或 back')
        sides.add(side)
        artwork = decode_image(raw_page.get('artwork'), f'{side} 彩稿')
        if common_size is not None and artwork.size != common_size:
            raise ExportError('正反面的像素尺寸须一致')
        common_size = artwork.size
        physical_width = project['widthMm'] + project['bleedMm'] * 2
        physical_height = project['heightMm'] + project['bleedMm'] * 2
        expected_width = artwork.height * physical_width / physical_height
        if abs(artwork.width - expected_width) > 2:
            raise ExportError('图片宽高比与含出血的项目尺寸不一致')
        raw_plates = raw_page.get('plates', {})
        if not isinstance(raw_plates, dict) or set(raw_plates) - set(ALTERNATES):
            raise ExportError('仅支持 white、foil、clear 工艺版')
        masks = {}
        thresholded = []
        for key, value in raw_plates.items():
            image = decode_image(value, f'{side} {key}')
            if image.size != artwork.size:
                raise ExportError(f'{side} 的 {key} 版与彩稿尺寸不一致')
            gray = np.asarray(image.convert('L'))
            if np.any((gray > 0) & (gray < 255)):
                thresholded.append(key)
            # One deterministic threshold is shared by the PDF stencil and TIFF.
            masks[key] = gray < 128
        pages.append({'side': side, 'artwork': artwork, 'masks': masks,
                      'thresholded': thresholded})
    pages.sort(key=lambda page: 0 if page['side'] == 'front' else 1)
    return project, profile, pages


def image_stencil(mask, writer):
    stream = DecodedStreamObject()
    stream.set_data(np.packbits(mask, axis=1).tobytes())
    stream.update(DictionaryObject({
        NameObject('/Type'): NameObject('/XObject'),
        NameObject('/Subtype'): NameObject('/Image'),
        NameObject('/ImageMask'): BooleanObject(True),
        NameObject('/BitsPerComponent'): NumberObject(1),
        NameObject('/Width'): NumberObject(mask.shape[1]),
        NameObject('/Height'): NumberObject(mask.shape[0]),
        NameObject('/Decode'): ArrayObject([NumberObject(1), NumberObject(0)]),
        NameObject('/Interpolate'): BooleanObject(False),
    }))
    return writer._add_object(stream.flate_encode())


def create_pdf(project, pages, names, output):
    bleed = project['bleedMm']
    width = project['widthMm']
    height = project['heightMm']
    size = ((width + 2 * bleed) * mm, (height + 2 * bleed) * mm)
    target = io.BytesIO()
    canvas = Canvas(target, pagesize=size, invariant=True, pdfVersion=(1, 6))
    canvas.setTitle(f"{project['name']} / {output}")
    canvas.setAuthor('Prism')
    page_masks = []
    for page in pages:
        masks = {}
        if output in ('artwork', 'composite'):
            # Generic RGB-to-CMYK conversion is disclosed in the export report.
            canvas.drawImage(ImageReader(page['artwork'].convert('CMYK')),
                             0, 0, width=size[0], height=size[1])
        for key, mask in page['masks'].items():
            if output not in ('composite', key):
                continue
            if output == 'composite':
                canvas.setFillOverprint(True)
                canvas.setOverprintMask(True)
                canvas.setFillColor(CMYKColorSep(*ALTERNATES[key], spotName=names[key]))
            else:
                canvas.setFillColorCMYK(0, 0, 0, 1)
            resource = f'/Plate_{key}'
            canvas.addLiteral(f'q {size[0]:.8f} 0 0 {size[1]:.8f} 0 0 cm {resource} Do Q')
            masks[resource] = mask
        page_masks.append(masks)
        canvas.showPage()
    canvas.save()
    writer = PdfWriter(clone_from=PdfReader(target))
    for page, masks in zip(writer.pages, page_masks, strict=True):
        page.trimbox = RectangleObject([bleed * mm, bleed * mm,
                                        (width + bleed) * mm, (height + bleed) * mm])
        page.bleedbox = RectangleObject([0, 0, *size])
        resources = page['/Resources']
        if '/XObject' not in resources:
            resources[NameObject('/XObject')] = DictionaryObject()
        xobjects = resources['/XObject']
        for resource, mask in masks.items():
            xobjects[NameObject(resource)] = image_stencil(mask, writer)
    output_bytes = io.BytesIO()
    writer.write(output_bytes)
    return output_bytes.getvalue()


def verify_pdf(data, project, pages, names, kind):
    """Read the completed document through pypdf before including it in the ZIP."""
    document = PdfReader(io.BytesIO(data))
    if len(document.pages) != len(pages):
        raise RuntimeError('PDF 页数校验失败')
    bleed = project['bleedMm']
    expected_trim = [bleed, bleed, project['widthMm'] + bleed, project['heightMm'] + bleed]
    for output_page, source_page in zip(document.pages, pages, strict=True):
        actual_trim = np.asarray(output_page.trimbox, dtype=float) / mm
        if not np.allclose(actual_trim, expected_trim, atol=0.00001):
            raise RuntimeError('PDF 成品框校验失败')
        if kind == 'composite':
            spaces = output_page['/Resources'].get('/ColorSpace', {})
            actual_spots = {
                str(value.get_object()[1]) for value in spaces.values()
                if isinstance(value.get_object(), list) and value.get_object()[0] == '/Separation'
            }
            expected_spots = {'/' + names[key] for key in source_page['masks']}
            if actual_spots != expected_spots:
                raise RuntimeError('PDF 专色通道校验失败')
            states = output_page['/Resources'].get('/ExtGState', {})
            if expected_spots and not any(bool(state.get_object().get('/op')) for state in states.values()):
                raise RuntimeError('PDF 叠印属性校验失败')


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, indent=2).encode('utf-8')


def export_package(payload):
    project, profile, pages = validate_request(payload)
    names = SPOT_PROFILES[profile]
    keys = [key for key in ALTERNATES if any(key in page['masks'] for page in pages)]
    files = {}
    for kind in ('artwork', 'composite', *keys):
        pdf = create_pdf(project, pages, names, kind)
        verify_pdf(pdf, project, pages, names, kind)
        files[f'{kind}.pdf'] = pdf
    physical_width = project['widthMm'] + 2 * project['bleedMm']
    physical_height = project['heightMm'] + 2 * project['bleedMm']
    page_reports = []
    for page in pages:
        size = page['artwork'].size
        dpi = (size[0] * 25.4 / physical_width, size[1] * 25.4 / physical_height)
        for key, mask in page['masks'].items():
            target = io.BytesIO()
            mono = Image.fromarray(np.where(mask, 0, 255).astype(np.uint8)).convert('1', dither=Image.Dither.NONE)
            mono.save(target, format='TIFF', compression='group4', dpi=dpi)
            readback = Image.open(io.BytesIO(target.getvalue()))
            if readback.mode != '1' or not np.array_equal(~np.asarray(readback), mask):
                raise RuntimeError('TIFF 工艺区域校验失败')
            files[f"{page['side']}-{key}.tif"] = target.getvalue()
        page_reports.append({
            'side': page['side'], 'pixels': list(size), 'dpi': [round(value, 2) for value in dpi],
            'plates': {names[key]: {'coveragePercent': round(float(mask.mean()) * 100, 3),
                                    'inkPixels': int(mask.sum())}
                       for key, mask in page['masks'].items()},
            'thresholdedMasks': page['thresholded'],
        })
    notices = [
        '本文件包为技术打样参考，尚未经过实际印厂 RIP 与实体打样验收。',
        '彩稿已栅格化为 DeviceCMYK 图像。通用 RGB 转 CMYK 未使用印厂 ICC，色彩需要印厂确认。',
        'PDF 为普通 PDF 1.6，未声明 PDF/X 合规，也未嵌入虚构的输出条件。',
        '工艺蒙版使用 128 阈值转为二值，PDF 与 TIFF 共用相同的二值数据。',
        '箔版中的全部选区合并为一道箔工艺。多种箔材需在生产前另行分版。',
    ]
    if any(min(page['dpi']) < 299 for page in page_reports):
        notices.append('部分卡面的有效分辨率低于 300 PPI，建议提升输出尺寸后重新导出。')
    report = {
        'schemaVersion': 1, 'engine': PRINT_ENGINE,
        'createdAt': datetime.now(timezone.utc).isoformat(), 'project': project,
        'profile': profile, 'spotNames': {key: names[key] for key in keys},
        'verificationStatus': 'software-structure-checked', 'productionApproved': False,
        'checks': ['尺寸与正反面对齐', 'PDF 页数与 TrimBox', '专色名称与叠印属性', 'TIFF 二值数据往返一致'],
        'pages': page_reports, 'notices': notices,
    }
    files['preflight-report.json'] = json_bytes(report)
    instructions = [
        '典藏卡技术打样文件', '', f"项目  {project['name']}", f"源版本  {project['version']:g}",
        f"成品  {project['widthMm']:g} × {project['heightMm']:g} mm",
        f"出血  四周 {project['bleedMm']:g} mm", f"材料  {project['material']}",
        '页序  ' + '、'.join('正面' if page['side'] == 'front' else '背面' for page in pages), '',
        'artwork.pdf 为 CMYK 彩稿。composite.pdf 为彩稿与命名专色合版。',
        'white.pdf、foil.pdf、clear.pdf 按实际使用工艺生成。独立版是纯 K 版。',
        '各面 TIFF 中黑色表示施作区域，白色表示空白。各版与彩稿使用同一物理坐标。',
        '未使用某道工艺的卡面在相应多页独立 PDF 中保留空白页，以维持页序。', '',
        '通道映射', *[f"{PLATE_LABELS[key]}  {names[key]}" for key in keys], '',
        '生产前确认', *notices,
        '请印厂确认实际材料、工序顺序、专色名称、套准容差、最小线宽、墨层和箔材要求。',
    ]
    files['production-notes.txt'] = '\n'.join(instructions).encode('utf-8')
    files['manifest.json'] = json_bytes({
        'projectId': project['id'], 'version': project['version'], 'profile': profile,
        'files': [{'path': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                  for path, data in files.items()],
    })
    target = io.BytesIO()
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path, data in files.items():
            archive.writestr(path, data)
    return target.getvalue()


class Handler(BaseHTTPRequestHandler):
    server_version = 'Prism/1.0'

    def origin_allowed(self):
        origin = self.headers.get('Origin')
        if not origin:
            return True
        parsed = urlsplit(origin)
        return parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1')

    def respond(self, status, body, content_type='application/json; charset=utf-8'):
        self.send_response(status)
        if self.origin_allowed() and self.headers.get('Origin'):
            self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if content_type == 'application/zip':
            self.send_header('Content-Disposition', 'attachment; filename="card-print-package.zip"')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        if not self.origin_allowed():
            self.respond(403, json_bytes({'error': '仅接受本机编辑器请求'}))
            return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin', 'http://localhost:5173'))
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if not self.origin_allowed():
            self.respond(403, json_bytes({'error': '仅接受本机编辑器请求'}))
        elif path == '/api/health':
            self.respond(200, json_bytes({'status': 'ok', 'engine': PRINT_ENGINE,
                                         'profiles': SPOT_PROFILES, 'productionApproved': False}))
        elif path == '/api/projects' or path.startswith('/api/projects/'):
            self.handle_projects(path)
        elif path == '/api' or path.startswith('/api/'):
            self.respond(404, json_bytes({'error': '接口不存在'}))
        else:
            self.serve_frontend(path)

    def handle_projects(self, path):
        if not self.origin_allowed():
            self.respond(403, json_bytes({'error': '仅接受本机编辑器请求'}))
            return
        parts = path.split('/')
        method = self.command
        try:
            store = self.server.projects
            if method == 'GET' and path == '/api/projects':
                self.respond(200, json_bytes(store.list()))
                return
            if len(parts) not in (4, 5) or not PROJECT_ID.fullmatch(parts[3]):
                raise ProjectError('项目地址无效', 404)
            project_id = parts[3]
            if method == 'GET' and len(parts) == 4:
                result = store.get(project_id)
            elif method == 'POST' and (len(parts) == 4 or parts[4] == 'archive'):
                if self.headers.get_content_type() != 'application/json':
                    raise ProjectError('请发送 JSON 项目数据')
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                except ValueError as error:
                    raise ProjectError('无效的项目大小') from error
                if not 0 < length <= MAX_PROJECT_REQUEST_BYTES:
                    raise ProjectError('项目数据超过保存上限，请移除部分大图后重试', 413)
                self.connection.settimeout(30)
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ProjectError('项目数据未接收完整，请重试')
                try:
                    payload = json.loads(raw)
                except (ValueError, UnicodeDecodeError, RecursionError) as error:
                    raise ProjectError('项目数据无法读取') from error
                if not isinstance(payload, dict):
                    raise ProjectError('项目数据格式无效')
                result = store.save(project_id, payload) if len(parts) == 4 else store.archive(project_id, payload)
            else:
                raise ProjectError('项目接口不存在', 404)
            self.respond(200, json_bytes(result))
        except ProjectError as error:
            self.respond(error.status, json_bytes({'error': str(error)}))
        except (sqlite3.Error, OSError) as error:
            self.log_error('Project storage: %s', error)
            self.respond(503, json_bytes({'error': '本机项目库暂时无法读写，请保留当前窗口并重试'}))

    def serve_frontend(self, request_path):
        try:
            path = unquote(request_path, errors='strict')
            if '\x00' in path or '\\' in path:
                raise ValueError('Invalid path')
            directory = DIST_DIRECTORY.resolve()
            requested = (directory / path.lstrip('/')).resolve()
            if not requested.is_relative_to(directory):
                self.respond(403, json_bytes({'error': '无法访问此路径'}))
                return
            if requested == directory:
                requested = directory / 'index.html'
            elif not requested.exists() and not requested.suffix:
                requested = directory / 'index.html'
            if not requested.is_file():
                self.respond(404, json_bytes({'error': '页面文件不存在，请先完成前端构建'}))
                return
            content_type = mimetypes.guess_type(requested.name)[0] or 'application/octet-stream'
            if requested.suffix == '.js':
                content_type = 'text/javascript'
            if content_type.startswith('text/'):
                content_type += '; charset=utf-8'
            self.respond(200, requested.read_bytes(), content_type)
        except (UnicodeError, ValueError, OSError):
            self.respond(400, json_bytes({'error': '无法读取请求的页面'}))

    def do_POST(self):
        if not self.origin_allowed():
            self.respond(403, json_bytes({'error': '仅接受本机编辑器请求'}))
            return
        path = urlsplit(self.path).path
        if path.startswith('/api/projects/'):
            self.handle_projects(path)
            return
        if path != '/api/export':
            self.respond(404, json_bytes({'error': '接口不存在'}))
            return
        if not EXPORT_SLOTS.acquire(blocking=False):
            self.respond(429, json_bytes({'error': '已有导出任务正在运行，请稍后重试'}))
            return
        try:
            try:
                length = int(self.headers.get('Content-Length', '0'))
            except ValueError as error:
                raise ExportError('无效的请求长度') from error
            if not 0 < length <= MAX_REQUEST_BYTES:
                raise ExportError('请求大小须在 120 MB 以内')
            if self.headers.get_content_type() != 'application/json':
                raise ExportError('请发送 JSON 项目快照')
            self.connection.settimeout(30)
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ExportError('上传内容不完整，请重试')
            try:
                payload = json.loads(raw)
            except (ValueError, UnicodeDecodeError) as error:
                raise ExportError('无法解析项目快照') from error
            result = export_package(payload)
            self.respond(200, result, 'application/zip')
        except ExportError as error:
            self.respond(400, json_bytes({'error': str(error)}))
        except TimeoutError:
            self.respond(408, json_bytes({'error': '上传超时，请重试'}))
        except Exception as error:
            self.log_error('Export failed: %s', error)
            self.respond(500, json_bytes({'error': '文件生成失败，请保留当前项目并重试'}))
        finally:
            EXPORT_SLOTS.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=4174)
    parser.add_argument('--data-dir', type=Path, default=Path.home() / 'Library' / 'Application Support' / 'Prism')
    args = parser.parse_args()
    store = ProjectStore(args.data_dir.expanduser() / 'projects.sqlite3')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.projects = store
    server.daemon_threads = True
    print(f'Prism ready on http://127.0.0.1:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
