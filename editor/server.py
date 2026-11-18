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
PRINT_ENGINE = 'prism-print/1.2'
DIST_DIRECTORY = Path(__file__).resolve().parent / 'dist'
SPOT_PROFILES = {
    'standard': {'white': 'White', 'foil': 'Foil_Gold', 'clear': 'Spot_UV',
                 'primer': 'Primer', 'spot': 'Spot_Ink', 'emboss': 'Emboss', 'deboss': 'Deboss'},
    'alternate': {'white': 'OPW', 'foil': 'FOIL', 'clear': 'CLEAR',
                  'primer': 'PRIMER', 'spot': 'SPOT_INK', 'emboss': 'EMBOSS', 'deboss': 'DEBOSS'},
}
ALTERNATES = {
    'white': (0, 0, 0, 0),
    'foil': (0, 0.3, 0.85, 0.1),
    'clear': (0, 0, 0, 0),
    'primer': (0, 0, 0, 0),
    'spot': (0.2, 0.8, 0, 0),
    'emboss': (0, 0, 0, 0),
    'deboss': (0, 0, 0, 0),
}
PLATE_LABELS = {'white': '白墨', 'foil': '箔', 'clear': '光油', 'primer': '底涂',
                'spot': '专色', 'emboss': '压凸', 'deboss': '压凹'}
MANUAL_OPERATIONS = {'lamination': '覆膜', 'coating': '全幅涂布', 'edge': '边缘处理',
                     'inspection': '质检与包装', 'custom': '其他工序'}
FACE_LABELS = {'front': '正面', 'back': '背面', 'both': '整卡'}


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
        'stockReflection': str(source.get('stockReflection', '未指定'))[:40],
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
        raw_layers = raw_page.get('layers')
        if not isinstance(raw_plates, dict) or set(raw_plates) - set(ALTERNATES):
            raise ExportError('存在当前版本无法识别的工艺通道')
        if raw_layers is not None and (raw_plates or not isinstance(raw_layers, list) or len(raw_layers) > 64):
            raise ExportError('每面最多支持 64 个独立工艺层')
        masks = {}
        thresholded = []
        layers = []

        def read_mask(value, label):
            image = decode_image(value, f'{side} {label}')
            if image.size != artwork.size:
                raise ExportError(f'{side} 的 {label} 版与彩稿尺寸不一致')
            gray = np.asarray(image.convert('L'))
            return gray < 128, bool(np.any((gray > 0) & (gray < 255)))

        if raw_layers is not None:
            ids = set()
            for item in raw_layers:
                if not isinstance(item, dict):
                    raise ExportError('工艺层数据无效')
                channel, layer_id, title = item.get('channel'), item.get('id'), item.get('name')
                if (not isinstance(channel, str) or channel not in ALTERNATES or
                        not isinstance(layer_id, str) or not 1 <= len(layer_id) <= 300 or layer_id in ids or
                        not isinstance(title, str) or not 1 <= len(title.strip()) <= 100):
                    raise ExportError('工艺层通道、标识或名称无效')
                ids.add(layer_id)
                mask, has_gray = read_mask(item.get('mask'), title)
                if not mask.any():
                    raise ExportError(f'「{title}」没有可输出的工艺覆盖区域')
                if has_gray:
                    thresholded.append(title)
                layers.append({'id': layer_id, 'name': title, 'channel': channel, 'mask': mask,
                               'regionId': str(item.get('regionId', ''))[:300],
                               'variant': str(item.get('variant', ''))[:40]})
                masks[channel] = (masks[channel] | mask) if channel in masks else mask
        else:
            for key, value in raw_plates.items():
                masks[key], has_gray = read_mask(value, key)
                if has_gray:
                    thresholded.append(key)
        pages.append({'side': side, 'artwork': artwork, 'masks': masks,
                      'thresholded': thresholded, 'layers': layers})
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


def create_die(project, shape, radius):
    width, height, bleed = (project[key] for key in ('widthMm', 'heightMm', 'bleedMm'))
    full_w, full_h = width + 2 * bleed, height + 2 * bleed
    width_pt, height_pt, inset = width * mm, height * mm, bleed * mm
    buffer = io.BytesIO()
    canvas = Canvas(buffer, pagesize=(full_w * mm, full_h * mm), invariant=True, pdfVersion=(1, 6))
    canvas.setTitle(f"{project['name']} / CutContour")
    canvas.setStrokeColor(CMYKColorSep(0, 1, 0, 0, spotName='CutContour'))
    canvas.setStrokeOverprint(True)
    canvas.setLineWidth(.25)
    if shape == 'ellipse':
        canvas.ellipse(inset, inset, inset + width_pt, inset + height_pt, stroke=1, fill=0)
        geometry = f'<ellipse cx="{bleed + width / 2:.8f}" cy="{bleed + height / 2:.8f}" rx="{width / 2:.8f}" ry="{height / 2:.8f}"/>'
    else:
        radius = radius if shape == 'card' else 0
        if radius:
            canvas.roundRect(inset, inset, width_pt, height_pt, radius * mm, stroke=1, fill=0)
        else:
            canvas.rect(inset, inset, width_pt, height_pt, stroke=1, fill=0)
        geometry = (f'<rect x="{bleed:.8f}" y="{bleed:.8f}" width="{width:.8f}" height="{height:.8f}"'
                    f' rx="{radius:.8f}" ry="{radius:.8f}"/>')
    canvas.showPage()
    canvas.save()
    writer = PdfWriter(clone_from=PdfReader(buffer))
    writer.pages[0].trimbox = RectangleObject([inset, inset, inset + width_pt, inset + height_pt])
    writer.pages[0].bleedbox = RectangleObject([0, 0, full_w * mm, full_h * mm])
    pdf = io.BytesIO()
    writer.write(pdf)
    data = pdf.getvalue()
    verify_pdf(data, project, [{}], {}, 'die')
    page = PdfReader(io.BytesIO(data)).pages[0]
    spots = page['/Resources'].get('/ColorSpace', {})
    if not any(list(spot.get_object()[:2]) == ['/Separation', '/CutContour'] for spot in spots.values()):
        raise RuntimeError('刀模专色校验失败')
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{full_w:.8f}mm" height="{full_h:.8f}mm"'
           f' viewBox="0 0 {full_w:.8f} {full_h:.8f}">'
           f'<g id="CutContour" fill="none" stroke="#ff00ff" stroke-width="{.25 / mm:.8f}">{geometry}</g></svg>')
    return {'die.pdf': data, 'die.svg': svg.encode('utf-8')}


def build_production_order(raw, project, reports):
    def read_text(source, key, limit):
        value = source.get(key, '')
        if not isinstance(value, str) or len(value) > limit:
            raise ExportError(f'工艺单字段 {key} 格式无效')
        return value.strip()

    if raw is not None and not isinstance(raw, dict):
        raise ExportError('工艺单格式无效')
    spec = raw if raw is not None else {}
    shape = spec.get('dieShape', 'card')
    flash = spec.get('flashTreatment', 'unused')
    if shape not in ('card', 'rectangle', 'ellipse') or flash not in ('unused', 'artwork', 'preview'):
        raise ExportError('刀模或闪光交付设置无效')
    maximum = min(project['widthMm'], project['heightMm']) / 2
    radius = numeric(spec.get('cornerRadiusMm', min(maximum, 1.8)), '圆角半径', 0, maximum)
    expected = {}
    rank = {kind: index for index, kind in enumerate(('primer', 'white', 'artwork', 'spot', 'foil', 'clear', 'emboss', 'deboss', 'die'))}
    for index, report in enumerate(reports, start=1):
        face = report['side']
        expected[f'{face}:artwork'] = dict(kind='artwork', face=face, name='彩稿', files=['artwork.pdf'], pdfPage=index)
        for layer in report['processLayers']:
            expected[f"{face}:layer:{layer['id']}"] = dict(
                kind='layer', face=face, name=layer['name'], layerId=layer['id'], channel=layer['channel'],
                separation=layer['spotName'], files=[layer['pdf'], layer['tiff']])
        # Keep old requests using aggregate plates readable in the new work order.
        if not report['processLayers']:
            for spot_name, plate in report['plates'].items():
                channel = plate['channel']
                expected[f'{face}:plate:{channel}'] = dict(kind='layer', face=face, name=PLATE_LABELS[channel],
                    channel=channel, separation=spot_name, files=[f'{channel}.pdf', f'{face}-{channel}.tif'], pdfPage=index)
    expected['die'] = dict(kind='die', face='both', name='模切', files=['die.pdf', 'die.svg'])
    rows = spec.get('steps')
    if rows is None:
        rows = [{'id': key} for key in sorted(expected, key=lambda key: rank[expected[key].get('channel', expected[key]['kind'])])]
    if not isinstance(rows, list) or len(rows) > 250:
        raise ExportError('工艺单最多允许 250 道工序')
    sides = {'both', *(report['side'] for report in reports)}
    seen = set()
    order = []
    for index, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            raise ExportError('工序格式无效')
        key = read_text(row, 'id', 330)
        kind, face = row.get('kind'), row.get('face')
        if not key or key in seen:
            raise ExportError('工序标识缺失或重复')
        seen.add(key)
        if key in expected:
            entry = expected.pop(key)
        elif isinstance(kind, str) and kind in MANUAL_OPERATIONS and isinstance(face, str) and face in sides:
            entry = dict(kind=kind, face=face, name=read_text(row, 'name', 100) or MANUAL_OPERATIONS[kind], files=[])
        else:
            raise ExportError('工艺单引用了本次未导出的卡面或分版')
        order.append(dict(entry, id=key, sequence=index, method=read_text(row, 'method', 120), note=read_text(row, 'note', 600)))
    if expected:
        raise ExportError('工艺单缺少应随文件导出的工序')
    job = {
        'schemaVersion': 1, 'project': project, 'printer': read_text(spec, 'printer', 120),
        'stockCode': read_text(spec, 'stockCode', 120), 'note': read_text(spec, 'note', 1200),
        'die': {'shape': shape, 'cornerRadiusMm': radius if shape == 'card' else 0, 'separation': 'CutContour'},
        'flashTreatment': flash, 'steps': order, 'status': 'pending-printer-confirmation',
    }
    return job, create_die(project, shape, radius)


def production_order_text(job):
    lines = ['Prism 卡牌生产工艺单', f"项目  {job['project']['name']}", '状态  待印厂确认',
             f"基材  {job['project']['material']}", f"底材反光  {job['project']['stockReflection']}"]
    if job['stockCode']:
        lines.append(f"印厂实际材料或料号  {job['stockCode']}")
    if job['printer']:
        lines.append(f"印厂  {job['printer']}")
    flash = {'unused': '未使用', 'artwork': '印为彩色图文', 'preview': '仅屏幕预览'}
    lines.extend([f"局部闪光  {flash[job['flashTreatment']]}", '', '工艺执行顺序'])
    for step in job['steps']:
        lines.append(f"{step['sequence']:02d}  {FACE_LABELS[step['face']]} · {step['name']}")
        if step['method']:
            lines.append(f"    做法或材料  {step['method']}")
        if step['note']:
            lines.append(f"    备注  {step['note']}")
        if step['files']:
            page = f"（第 {step['pdfPage']} 页）" if 'pdfPage' in step else ''
            lines.append(f"    文件  {' / '.join(step['files'])}{page}")
    if job['note']:
        lines.extend(['', '整卡交付备注', job['note']])
    return '\n'.join(lines).encode('utf-8')


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, indent=2).encode('utf-8')


def encode_plate_tiff(mask, dpi):
    target = io.BytesIO()
    mono = Image.fromarray(np.where(mask, 0, 255).astype(np.uint8)).convert('1', dither=Image.Dither.NONE)
    mono.save(target, format='TIFF', compression='group4', dpi=dpi)
    data = target.getvalue()
    with Image.open(io.BytesIO(data)) as readback:
        if readback.mode != '1' or not np.array_equal(~np.asarray(readback), mask):
            raise RuntimeError('TIFF 工艺区域校验失败')
    return data


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
            files[f"{page['side']}-{key}.tif"] = encode_plate_tiff(mask, dpi)
        layer_reports = []
        for index, layer in enumerate(page['layers'], start=1):
            key, mask = layer['channel'], layer['mask']
            stem = f"layers/{page['side']}-{index:02d}-{key}"
            solo = {**page, 'masks': {key: mask}}
            pdf = create_pdf(project, [solo], names, key)
            verify_pdf(pdf, project, [solo], names, key)
            files[f'{stem}.pdf'] = pdf
            files[f'{stem}.tif'] = encode_plate_tiff(mask, dpi)
            layer_reports.append({
                'id': layer['id'], 'name': layer['name'], 'channel': key, 'spotName': names[key],
                'variant': layer['variant'], 'regionId': layer['regionId'],
                'inkPixels': int(mask.sum()), 'pdf': f'{stem}.pdf', 'tiff': f'{stem}.tif',
            })
        page_reports.append({
            'side': page['side'], 'pixels': list(size), 'dpi': [round(value, 2) for value in dpi],
            'plates': {names[key]: {'channel': key, 'coveragePercent': round(float(mask.mean()) * 100, 3),
                                    'inkPixels': int(mask.sum())}
                       for key, mask in page['masks'].items()},
            'thresholdedMasks': page['thresholded'], 'processLayers': layer_reports,
        })
    order, die_files = build_production_order(payload.get('production'), project, page_reports)
    files.update(die_files)
    files['production-order.json'] = json_bytes(order)
    files['production-order.txt'] = production_order_text(order)
    notices = [
        '本文件包为技术打样参考，尚未经过实际印厂 RIP 与实体打样验收。',
        '彩稿已栅格化为 DeviceCMYK 图像。通用 RGB 转 CMYK 未使用印厂 ICC，色彩需要印厂确认。',
        'PDF 为普通 PDF 1.6，未声明 PDF/X 合规，也未嵌入虚构的输出条件。',
        '工艺蒙版使用 128 阈值转为二值，PDF 与 TIFF 共用相同的二值数据。',
        '合版 PDF 的专色按通道合并，供读版核对。layers/ 保留各工艺层，请按印厂确认的工序交付。',
        '专色分版为实地二值蒙版，实际色号请查工艺单。压凸与压凹分版仅描述平面区域，模具结构及深度由印厂确认。',
    ]
    if any(min(page['dpi']) < 299 for page in page_reports):
        notices.append('部分卡面的有效分辨率低于 300 PPI，建议提升输出尺寸后重新导出。')
    report = {
        'schemaVersion': 1, 'engine': PRINT_ENGINE,
        'createdAt': datetime.now(timezone.utc).isoformat(), 'project': project,
        'profile': profile, 'spotNames': {key: names[key] for key in keys},
        'verificationStatus': 'software-structure-checked', 'productionApproved': False,
        'checks': ['尺寸与正反面对齐', 'PDF 页数与 TrimBox', '专色名称与叠印属性', 'TIFF 二值数据往返一致',
                   '独立刀模 CutContour 与成品框', '工艺单与实际分版对应'],
        'pages': page_reports, 'notices': notices,
    }
    files['preflight-report.json'] = json_bytes(report)
    instructions = [
        '典藏卡技术打样文件', '', f"项目  {project['name']}", f"源版本  {project['version']:g}",
        f"成品  {project['widthMm']:g} × {project['heightMm']:g} mm",
        f"出血  四周 {project['bleedMm']:g} mm", f"材料  {project['material']}",
        f"底材反光  {project['stockReflection']}",
        '页序  ' + '、'.join('正面' if page['side'] == 'front' else '背面' for page in pages), '',
        'artwork.pdf 为 CMYK 彩稿。composite.pdf 为彩稿与命名专色合版。',
        '各工艺按实际使用情况输出独立纯 K 版。模切使用 die.pdf 或 die.svg。',
        'production-order.txt 记录每道工序的顺序、加工面、做法及配套文件。',
        '各面 TIFF 中黑色表示施作区域，白色表示空白。各版与彩稿使用同一物理坐标。',
        '未使用某道工艺的卡面在相应多页独立 PDF 中保留空白页，以维持页序。', '',
        '通道映射', *[f"{PLATE_LABELS[key]}  {names[key]}" for key in keys], '',
        '独立工艺层', *[f"{layer['name']}  {layer['pdf']}"
                       for page in page_reports for layer in page['processLayers']], '',
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
                                         'profiles': SPOT_PROFILES, 'layeredPlates': True,
                                         'productionOrder': True, 'productionApproved': False}))
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
