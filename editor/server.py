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
import re
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
from reportlab.lib.colors import CMYKColorSep, Color
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas


MAX_PROJECT_REQUEST_BYTES = 150 * 1024 * 1024
MAX_REQUEST_BYTES = 120 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 24_000_000
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
EXPORT_SLOTS = threading.BoundedSemaphore(2)
PRINT_ENGINE = 'prism-print/1.4'
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
FINISH_LABELS = {
    'none': '无反光', 'mirror': '亮银', 'matte-silver': '亚银', 'rainbow': '素面彩虹',
    'dots': '点闪', 'cracked-ice': '碎冰', 'pillar': '光柱', 'radial': '放射镭射',
}
FINISH_METHODS = {'composite': '预制复合卡基', 'underprint': '印前复合或转移', 'overlaminate': '印后覆膜'}
METAL_FINISHES = ('mirror', 'matte-silver')
STOCK_CORES = {'white': '白芯', 'none': '无芯', 'blue': '蓝芯', 'black': '黑芯', 'gray': '灰芯'}


class ExportError(ValueError):
    """A user-correctable invalid request."""


def numeric(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ExportError(f'{name}必须是数字')
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise ExportError(f'{name}须在 {minimum}–{maximum} 之间')
    return float(value)


def decode_image(value, label, transparent=False):
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
                if not transparent and (source.width < 32 or source.height < 32):
                    raise ExportError(f'{label}的尺寸过小')
                source.load()
                rgba = source.convert('RGBA')
                if transparent:
                    return rgba
                background = Image.new('RGBA', source.size, 'white')
                return Image.alpha_composite(background, rgba).convert('RGB')
    except (binascii.Error, UnidentifiedImageError, OSError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise ExportError(f'{label}无法读取，请重新导出图片') from error


def vector_values(value, size, low=-1_000_000, high=1_000_000):
    if not isinstance(value, list) or len(value) != size:
        raise ExportError('矢量彩稿坐标或颜色格式无效')
    return tuple(numeric(component, '矢量彩稿值', low, high) for component in value)


def read_vector_artwork(raw):
    if not isinstance(raw, dict) or not isinstance(raw.get('parts'), list) or len(raw['parts']) > 1200:
        raise ExportError('矢量彩稿最多包含 1200 个图层')
    paper = vector_values(raw.get('paper', [1, 1, 1]), 3, 0, 1)
    parts = []
    command_count = 0
    image_pixels = 0
    for item in raw['parts']:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or len(item['id']) > 300:
            raise ExportError('矢量彩稿图层标识无效')
        part = {'id': item['id'], 'type': item.get('type')}
        if part['type'] == 'bitmap':
            left, top, width, height = vector_values(item.get('box'), 4)
            if width <= 0 or height <= 0:
                raise ExportError('局部栅格图层的尺寸无效')
            image = decode_image(item.get('image'), '局部栅格图层', transparent=True)
            image_pixels += image.width * image.height
            if image_pixels > MAX_IMAGE_PIXELS * 4:
                raise ExportError('局部栅格图层总像素过大，请降低分辨率')
            part.update(box=(left, top, width, height), image=image)
        elif part['type'] == 'path':
            commands = item.get('path')
            if not isinstance(commands, list) or not commands:
                raise ExportError('矢量路径不能为空')
            command_count += len(commands)
            if command_count > 300_000:
                raise ExportError('矢量彩稿路径过多')
            path = []
            sizes = {'M': 2, 'L': 2, 'C': 6, 'Z': 0}
            for command in commands:
                if (not isinstance(command, list) or not command or not isinstance(command[0], str)
                        or command[0] not in sizes or (not path and command[0] != 'M')):
                    raise ExportError('矢量路径指令无效')
                path.append((command[0], *vector_values(command[1:], sizes[command[0]])))
            rule = item.get('fillRule', 'nonzero')
            if rule not in ('nonzero', 'evenodd'):
                raise ExportError('矢量填充规则无效')
            part.update(path=path, matrix=vector_values(item.get('matrix'), 6), fillMode=0 if rule == 'evenodd' else 1)
            if 'textBox' in item:
                part['textBox'] = vector_values(item['textBox'], 2, .001, 100_000)
            fill = item.get('fill')
            if fill is not None:
                if not isinstance(fill, dict) or fill.get('kind') not in ('solid', 'linear', 'radial'):
                    raise ExportError('矢量路径填充无效')
                kind = fill['kind']
                paint = {'kind': kind, 'opacity': numeric(fill.get('opacity'), '填充不透明度', 0, 1)}
                if kind == 'solid':
                    paint['color'] = vector_values(fill.get('color'), 3, 0, 1)
                else:
                    points, stops = fill.get('points'), fill.get('stops')
                    if not isinstance(points, list) or len(points) != 2 or not isinstance(stops, list) or not 2 <= len(stops) <= 24:
                        raise ExportError('矢量渐变格式无效')
                    paint['points'] = [vector_values(point, 2) for point in points]
                    if kind == 'radial' and 'radialAxis' in fill:
                        paint['radialAxis'] = vector_values(fill['radialAxis'], 2)
                    clean_stops = []
                    for stop in stops:
                        if not isinstance(stop, list) or len(stop) != 2:
                            raise ExportError('矢量渐变色标无效')
                        position = numeric(stop[0], '渐变位置', 0, 1)
                        if clean_stops and position <= clean_stops[-1][0]:
                            raise ExportError('矢量渐变色标必须按顺序分开')
                        clean_stops.append((position, vector_values(stop[1], 3, 0, 1)))
                    paint['stops'] = clean_stops
                part['fill'] = paint
            stroke = item.get('stroke')
            if stroke is not None:
                if not isinstance(stroke, dict) or stroke.get('style') not in ('solid', 'dashed', 'dotted'):
                    raise ExportError('矢量路径描边无效')
                cap = stroke.get('cap', 'butt')
                join = stroke.get('join', 'round')
                if cap not in ('butt', 'round', 'square') or join not in ('miter', 'round', 'bevel'):
                    raise ExportError('描边端点或转角无效')
                part['stroke'] = dict(color=vector_values(stroke.get('color'), 3, 0, 1), style=stroke['style'], cap=cap, join=join,
                                      miter=numeric(stroke.get('miter', 10), '描边斜接限制', 1, 1000),
                                      width=numeric(stroke.get('width'), '描边宽度', .00001, 1000),
                                      opacity=numeric(stroke.get('opacity'), '描边不透明度', 0, 1))
        else:
            raise ExportError('矢量彩稿含未知的图层类型')
        parts.append(part)
    return {'paper': paper, 'parts': parts}


def read_stock_spec(raw):
    if not isinstance(raw, dict) or ('grammageGsm' in raw and 'thicknessMm' in raw):
        raise ExportError('卡基规格无效')
    stock = {}
    for key, label, lower, upper in (('grammageGsm', '卡基克重', 1, 2000), ('thicknessMm', '卡基片厚', .01, 10)):
        if key in raw:
            stock[key] = numeric(raw[key], label, lower, upper)
    if 'core' in raw:
        core = raw['core']
        if not isinstance(core, str) or core not in STOCK_CORES:
            raise ExportError('卡基芯层无效')
        stock['core'] = core
    return stock


def read_face_finishes(raw, sides):
    if not isinstance(raw, list) or len(raw) != len(sides):
        raise ExportError('反光用料需与交稿卡面对应')
    finishes = {}
    for row in raw:
        if not isinstance(row, dict):
            raise ExportError('卡面反光格式无效')
        side, style, status = row.get('side'), row.get('style'), row.get('status')
        if not isinstance(side, str) or side not in sides or side in finishes:
            raise ExportError('反光用料需与交稿卡面对应')
        if (not isinstance(style, str) or style not in FINISH_LABELS or
                status not in ('pending', 'confirmed', 'not-used') or
                (status == 'not-used' and style != 'none') or (status == 'confirmed' and style == 'none')):
            raise ExportError('反光样式或确认状态无效')
        finish = {'side': side, 'style': style, 'label': FINISH_LABELS[style], 'status': status}
        if status == 'confirmed':
            method, transparent = row.get('method'), row.get('transparent')
            material_code = read_work_text(row, 'materialCode', 120)
            pattern_code = read_work_text(row, 'patternCode', 120)
            patterned = style not in METAL_FINISHES
            if (not material_code or (patterned and not pattern_code) or
                    not isinstance(method, str) or method not in FINISH_METHODS or
                    not isinstance(transparent, bool) or (transparent and style in METAL_FINISHES)):
                raise ExportError(f'{FACE_LABELS[side]}反光用料不完整或不兼容')
            finish.update(materialCode=material_code, method=method, transparent=transparent,
                          orientationDeg=numeric(row.get('orientationDeg'), '底材反光纹向', -360, 360))
            if pattern_code:
                finish['patternCode'] = pattern_code
        finishes[side] = finish
    return [finishes[side] for side in ('front', 'back') if side in sides]


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
    if 'cardId' in source:
        card_id = read_work_text(source, 'cardId', 302)
        if not card_id:
            raise ExportError('卡牌标识无效')
        project['cardId'] = card_id
    if 'stockSpec' in source:
        project['stockSpec'] = read_stock_spec(source['stockSpec'])
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
            total_plate_commands = 0
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
                contours = item.get('contours')
                if contours is not None:
                    if not isinstance(contours, list) or not 0 < len(contours) <= 1000:
                        raise ExportError('工艺版矢量轮廓无效')
                    for contour in contours:
                        if (not isinstance(contour, dict) or contour.get('type') != 'path'
                                or set(contour) - {'id', 'type', 'matrix', 'path', 'fillRule'}
                                or not isinstance(contour.get('path'), list)):
                            raise ExportError('工艺版矢量路径无效')
                        total_plate_commands += len(contour['path'])
                    if total_plate_commands > 300_000:
                        raise ExportError('工艺版矢量路径过多')
                    contours = read_vector_artwork({'parts': contours})['parts']
                layers.append({'id': layer_id, 'name': title, 'channel': channel, 'mask': mask,
                               'contours': contours,
                               'regionId': str(item.get('regionId', ''))[:300],
                               'variant': str(item.get('variant', ''))[:40]})
                masks[channel] = (masks[channel] | mask) if channel in masks else mask
        else:
            for key, value in raw_plates.items():
                masks[key], has_gray = read_mask(value, key)
                if has_gray:
                    thresholded.append(key)
        vector = read_vector_artwork(raw_page['vector']) if 'vector' in raw_page else None
        pages.append({'side': side, 'artwork': artwork, 'masks': masks, 'vector': vector,
                      'thresholded': thresholded, 'layers': layers})
    pages.sort(key=lambda page: 0 if page['side'] == 'front' else 1)
    if 'faceFinishes' in source:
        project['faceFinishes'] = read_face_finishes(source['faceFinishes'], sides)
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


def draw_vector_artwork(canvas, vector, size, bleed):
    canvas.saveState()
    canvas.setFillColorRGB(*vector['paper'])
    canvas.rect(0, 0, *size, stroke=0, fill=1)
    unit = mm / 10
    canvas.translate(bleed * mm, size[1] - bleed * mm)
    canvas.scale(unit, -unit)
    for part in vector['parts']:
        canvas.saveState()
        if part['type'] == 'bitmap':
            x, y, width, height = part['box']
            canvas.translate(x, y + height)
            canvas.scale(1, -1)
            canvas.drawImage(ImageReader(part['image']), 0, 0, width=width, height=height, mask='auto')
        else:
            canvas.transform(*part['matrix'])
            if 'textBox' in part:
                box = canvas.beginPath()
                box.rect(0, 0, *part['textBox'])
                canvas.clipPath(box, stroke=0, fill=0)
            path = canvas.beginPath()
            draw = {'M': path.moveTo, 'L': path.lineTo, 'C': path.curveTo, 'Z': path.close}
            for verb, *values in part['path']:
                draw[verb](*values)
            fill, stroke = part.get('fill'), part.get('stroke')
            if stroke:
                canvas.setStrokeColorRGB(*stroke['color'])
                canvas.setStrokeAlpha(stroke['opacity'])
                line_width = stroke['width']
                canvas.setLineWidth(line_width)
                canvas.setLineCap(('butt', 'round', 'square').index(stroke['cap']))
                canvas.setLineJoin(('miter', 'round', 'bevel').index(stroke['join']))
                canvas.setMiterLimit(stroke['miter'])
                if stroke['style'] == 'dashed':
                    canvas.setDash([line_width * 4, line_width * 2.5])
                if stroke['style'] == 'dotted':
                    canvas.setLineCap(1)
                    canvas.setDash([0, line_width * 3])
                if 'textBox' in part:
                    canvas.drawPath(path, stroke=1, fill=0)
            if fill:
                canvas.saveState()
                canvas.setFillAlpha(fill['opacity'])
                if fill['kind'] == 'solid':
                    canvas.setFillColorRGB(*fill['color'])
                    canvas.drawPath(path, stroke=0, fill=1, fillMode=part.get('fillMode', 1))
                else:
                    canvas.clipPath(path, stroke=0, fill=0, fillMode=part.get('fillMode', 1))
                    (x1, y1), (x2, y2) = fill['points']
                    stops = fill['stops']
                    positions = [offset for offset, _ in stops]
                    colors = [Color(*color) for _, color in stops]
                    if fill['kind'] == 'radial':
                        axis = fill.get('radialAxis')
                        dx, dy = x2 - x1, y2 - y1
                        if axis and abs(dx * axis[1] - dy * axis[0]) > 1e-8:
                            canvas.transform(dx, dy, *axis, x1, y1)
                            canvas.radialGradient(0, 0, 1, colors, positions)
                        else:
                            canvas.radialGradient(x1, y1, max(.001, math.hypot(dx, dy)), colors, positions)
                    else:
                        canvas.linearGradient(x1, y1, x2 if x1 != x2 or y1 != y2 else x2 + .001, y2, colors, positions)
                canvas.restoreState()
            if stroke and 'textBox' not in part:
                canvas.drawPath(path, stroke=1, fill=0)
        canvas.restoreState()
    canvas.restoreState()


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
            if page['vector'] is not None:
                draw_vector_artwork(canvas, page['vector'], size, bleed)
            else:
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
            layers = [layer for layer in page.get('layers', ()) if layer['channel'] == key]
            if layers and all(layer.get('contours') for layer in layers):
                canvas.saveState()
                canvas.translate(bleed * mm, size[1] - bleed * mm)
                canvas.scale(mm / 10, -mm / 10)
                for layer in layers:
                    for contour in layer['contours']:
                        canvas.saveState()
                        canvas.transform(*contour['matrix'])
                        path = canvas.beginPath()
                        commands = {'M': path.moveTo, 'L': path.lineTo, 'C': path.curveTo, 'Z': path.close}
                        for verb, *values in contour['path']:
                            commands[verb](*values)
                        canvas.drawPath(path, stroke=0, fill=1, fillMode=contour['fillMode'])
                        canvas.restoreState()
                canvas.restoreState()
                continue
            resource = f'/Plate_{key}'
            canvas.addLiteral(f'q {size[0]:.8f} 0 0 {size[1]:.8f} 0 0 cm {resource} Do Q')
            masks[resource] = mask
        page_masks.append(masks)
        canvas.showPage()
    canvas.save()
    writer = PdfWriter(clone_from=PdfReader(target))
    writer.pdf_header = '%PDF-1.6'
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
    expected_bleed = [0, 0, project['widthMm'] + 2 * bleed, project['heightMm'] + 2 * bleed]
    if not document.pdf_header.startswith('%PDF-1.6'):
        raise RuntimeError('PDF 版本核验失败')
    for output_page, source_page in zip(document.pages, pages, strict=True):
        actual_trim = np.asarray(output_page.trimbox, dtype=float) / mm
        if not np.allclose(actual_trim, expected_trim, atol=0.00001):
            raise RuntimeError('PDF 成品框校验失败')
        if not np.allclose(np.asarray(output_page.bleedbox, dtype=float) / mm, expected_bleed, atol=0.00001):
            raise RuntimeError('PDF 出血框校验失败')
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
    writer.pdf_header = '%PDF-1.6'
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


def read_work_text(source, key, limit):
    value = source.get(key, '')
    if not isinstance(value, str) or len(value) > limit:
        raise ExportError(f'工艺单字段 {key} 格式无效')
    return value.strip()


FACTORY_STAGE_LABELS = {**PLATE_LABELS, **MANUAL_OPERATIONS, 'artwork': '彩稿', 'die': '模切'}


def factory_process_rules(spec):
    rules = spec.get('processRules', [])
    if not isinstance(rules, list) or len(rules) > 200:
        raise ExportError('厂规工序规则无效')
    for rule in rules:
        if not isinstance(rule, dict):
            raise ExportError('厂规工序规则无效')
        stage, after = rule.get('stage'), rule.get('after')
        if (not isinstance(stage, str) or stage not in FACTORY_STAGE_LABELS or
                not isinstance(after, str) or after not in FACTORY_STAGE_LABELS or
                stage == after or not isinstance(rule.get('required', False), bool)):
            raise ExportError('厂规工序规则无效')
    return rules


def verify_factory_process_order(steps, rules):
    for rule in rules:
        for step in steps:
            if step.get('channel', step['kind']) != rule['stage']:
                continue
            previous = [entry for entry in steps
                        if entry.get('channel', entry['kind']) == rule['after'] and
                        (step['face'] == 'both' or entry['face'] == 'both' or step['face'] == entry['face'])]
            if not previous and rule.get('required'):
                raise ExportError(f"「{step['name']}」须先完成{FACTORY_STAGE_LABELS[rule['after']]}，当前交稿缺少该工序")
            if any(entry['sequence'] >= step['sequence'] for entry in previous):
                raise ExportError(f"「{step['name']}」的工序顺序与所选厂规不符")


def configured_print(payload, project, pages, profile):
    raw = payload.get('production')
    spec = raw.get('printProfile') if isinstance(raw, dict) else None
    names = dict(SPOT_PROFILES[profile])
    if spec is None:
        return None, names
    if not isinstance(spec, dict) or spec.get('route') != 'specialty':
        raise ExportError('工艺配置不是技术分版路线')
    if spec.get('colorRequirement') != 'standard' or spec.get('requireVectorPlates') is not False:
        raise ExportError('技术打样引擎不支持此配置的 ICC 或矢量工艺要求')
    config = {
        key: read_work_text(spec, key, limit)
        for key, limit in (('product', 120), ('version', 60), ('reference', 600))
    }
    if not all(config.values()) or not read_work_text(raw, 'printer', 120) or not read_work_text(raw, 'stockCode', 120):
        raise ExportError('请填写印厂、产品、材料料号、厂规版本和依据')
    for finish in project.get('faceFinishes', ()):
        if finish['status'] == 'pending':
            raise ExportError(f"{FACE_LABELS[finish['side']]}底材反光待印厂确认")
    for key, label, lo, hi in (('widthMm', '成品宽度', 20, 300), ('heightMm', '成品高度', 20, 300), ('bleedMm', '出血', 0, 20)):
        value = numeric(spec.get(key), label, lo, hi)
        if abs(value - project[key]) > .005:
            raise ExportError(f'{label}与厂规不符')
        config[key] = value
    dpi = numeric(spec.get('dpi'), '输出分辨率', 150, 1200)
    dimensions = ((config[key] + 2 * config['bleedMm']) * dpi / 25.4 for key in ('widthMm', 'heightMm'))
    if any(abs(pixels - expected) > .51 for pixels, expected in zip(pages[0]['artwork'].size, dimensions)):
        raise ExportError('输出像素尺寸与所选厂规分辨率不符')
    faces = spec.get('faces')
    sides = [page['side'] for page in pages]
    if faces not in ('both', 'front', 'either') or (faces == 'both' and sides != ['front', 'back']) or (faces == 'front' and sides != ['front']):
        raise ExportError('输出卡面与厂规不符')
    orientation = spec.get('backOrientation', 'normal')
    if orientation not in ('normal', 'rotate180', 'mirror'):
        raise ExportError('背面方向无效')
    custom = spec.get('spotNames')
    if not isinstance(custom, dict) or set(custom) - {'white', 'foil'}:
        raise ExportError('专色通道无效')
    for key in custom:
        name = read_work_text(custom, key, 64)
        if name and not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', name):
            raise ExportError('专色名称无效')
        if name:
            names[key] = name
    if len(set(names.values())) != len(names) or 'CutContour' in names.values():
        raise ExportError('专色名称不能与其它通道或刀线重名')
    config.update(route='specialty', colorRequirement='standard', dpi=dpi, faces=faces,
                  backOrientation=orientation, spotNames={key: names[key] for key in custom},
                  safeMm=numeric(spec.get('safeMm'), '正文安全区内缩', 0, 20),
                  minImagePpi=numeric(spec.get('minImagePpi'), '原图最低有效 PPI', 0, 1200),
                  minPlateWidthMm=numeric(spec.get('minPlateWidthMm'), '工艺最小线宽', 0, 10),
                  minKnockoutMm=numeric(spec.get('minKnockoutMm', 0), '版内最小反白间隙', 0, 10),
                  plateTrimMarginMm=numeric(spec.get('plateTrimMarginMm'), '工艺版离裁切边', 0, 20),
                  whiteFoilGapMm=numeric(spec.get('whiteFoilGapMm'), '白墨与箔版间距', 0, 10))
    for key in ('requireBleedArtwork', 'foilWhiteOverlap'):
        if not isinstance(spec.get(key), bool):
            raise ExportError(f'工艺配置字段 {key} 无效')
        config[key] = spec[key]
    rules = factory_process_rules(spec)
    if rules:
        config['processRules'] = rules
    return config, names


def read_preflight(payload):
    raw = payload.get('preflight', [])
    if not isinstance(raw, list) or len(raw) > 20_000:
        raise ExportError('印前检查报告无效')
    findings = []
    for finding in raw:
        if not isinstance(finding, dict) or finding.get('blocking') is not False:
            raise ExportError('请先处理印前检查的阻塞问题')
        findings.append({'text': read_work_text(finding, 'text', 1000), 'blocking': False})
    return findings


def build_production_order(raw, project, reports):
    read_text = read_work_text

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
        required = read_text(row, 'requiresStepId', 330)
        if required and (required == key or required not in seen):
            raise ExportError('工艺顺序缺少前置工序，或前置工序顺序不正确')
        order.append(dict(entry, id=key, sequence=index, method=read_text(row, 'method', 120), note=read_text(row, 'note', 600),
                          materialCode=read_text(row, 'materialCode', 120), requiresStepId=required))
    if expected:
        raise ExportError('工艺单缺少应随文件导出的工序')
    job = {
        'schemaVersion': 1, 'project': project, 'printer': read_text(spec, 'printer', 120),
        'stockCode': read_text(spec, 'stockCode', 120), 'note': read_text(spec, 'note', 1200),
        'die': {'shape': shape, 'cornerRadiusMm': radius if shape == 'card' else 0, 'separation': 'CutContour'},
        'flashTreatment': flash, 'steps': order, 'status': 'pending-printer-confirmation',
    }
    return job, create_die(project, shape, radius)


def stock_details_text(project):
    stock = project.get('stockSpec', {})
    details = [project['material']]
    if 'grammageGsm' in stock:
        details.append(f"{stock['grammageGsm']:g} g/m²")
    if 'thicknessMm' in stock:
        details.append(f"{stock['thicknessMm']:g} mm")
    if 'core' in stock:
        details.append(STOCK_CORES[stock['core']])
    lines = ['卡基  ' + ' · '.join(details)]
    if 'cardId' in project:
        lines.insert(0, f"卡牌标识  {project['cardId']}")
    if 'faceFinishes' not in project:
        return [*lines, f"底材反光  {project['stockReflection']}"]
    for finish in project['faceFinishes']:
        parts = [finish['label']]
        if finish['status'] == 'pending':
            parts.append('待印厂确认')
        if finish['status'] == 'confirmed':
            parts.append(f"反光料号 {finish['materialCode']}")
            if 'patternCode' in finish:
                parts.append(f"纹样号 {finish['patternCode']}")
            parts.extend([f"纹向 {finish['orientationDeg']:g}°", FINISH_METHODS[finish['method']],
                          '反光材料透光' if finish['transparent'] else '反光材料不透光'])
        lines.append(f"{FACE_LABELS[finish['side']]}底材反光  " + ' · '.join(parts))
    return lines


def production_order_text(job):
    lines = ['Prism 卡牌生产工艺单', f"项目  {job['project']['name']}", '状态  待印厂确认',
             *stock_details_text(job['project'])]
    if job['stockCode']:
        lines.append(f"印厂实际材料或料号  {job['stockCode']}")
    if job['printer']:
        lines.append(f"印厂  {job['printer']}")
    if 'factoryProfile' in job:
        factory = job['factoryProfile']
        lines.extend([f"产品  {factory['product']}", f"厂规  {factory['version']} · {factory['reference']}"])
    flash = {'unused': '未使用', 'artwork': '印为彩色图文', 'preview': '仅屏幕预览'}
    lines.extend([f"局部闪光  {flash[job['flashTreatment']]}", '', '工艺执行顺序'])
    for step in job['steps']:
        lines.append(f"{step['sequence']:02d}  {FACE_LABELS[step['face']]} · {step['name']}")
        if step['materialCode']:
            lines.append(f"    物料编号  {step['materialCode']}")
        if step['requiresStepId']:
            required = next(item for item in job['steps'] if item['id'] == step['requiresStepId'])
            lines.append(f"    前置工序  {required['sequence']:02d} · {required['name']}")
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
    factory, names = configured_print(payload, project, pages, profile)
    vector = pages[0]['vector'] is not None
    if any((page['vector'] is not None) != vector for page in pages) or (vector and factory):
        raise ExportError('基础矢量彩稿仅用于通用技术打样，正反面须使用相同输出方式')
    findings = read_preflight(payload)
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
            solo = {**page, 'layers': [layer], 'masks': {key: mask}}
            pdf = create_pdf(project, [solo], names, key)
            verify_pdf(pdf, project, [solo], names, key)
            files[f'{stem}.pdf'] = pdf
            files[f'{stem}.tif'] = encode_plate_tiff(mask, dpi)
            layer_reports.append({
                'id': layer['id'], 'name': layer['name'], 'channel': key, 'spotName': names[key],
                'variant': layer['variant'], 'regionId': layer['regionId'],
                'geometry': 'vector' if layer.get('contours') else 'raster',
                'inkPixels': int(mask.sum()), 'pdf': f'{stem}.pdf', 'tiff': f'{stem}.tif',
            })
        page_reports.append({
            'side': page['side'], 'pixels': list(size), 'dpi': [round(value, 2) for value in dpi],
            'plates': {names[key]: {'channel': key, 'coveragePercent': round(float(mask.mean()) * 100, 3),
                                    'inkPixels': int(mask.sum())}
                       for key, mask in page['masks'].items()},
            'thresholdedMasks': page['thresholded'], 'processLayers': layer_reports,
        })
        if vector:
            page_reports[-1]['artworkParts'] = [dict(id=part['id'], type='outlined-text' if 'textBox' in part else part['type'])
                                                for part in page['vector']['parts']]
    order, die_files = build_production_order(payload.get('production'), project, page_reports)
    if factory:
        verify_factory_process_order(order['steps'], factory.get('processRules', []))
        order['factoryProfile'] = factory
    files.update(die_files)
    files['production-order.json'] = json_bytes(order)
    files['production-order.txt'] = production_order_text(order)
    notices = [
        '本文件包为技术打样参考，尚未经过实际印厂 RIP 与实体打样验收。',
        ('基础矢量彩稿使用 RGB 路径、渐变、文字轮廓及局部透明位图，印厂专色版独立保留。' if vector else
         '彩稿已栅格化为 DeviceCMYK 图像。通用 RGB 转 CMYK 未使用印厂 ICC，色彩需要印厂确认。'),
        'PDF 为普通技术交稿 PDF，未声明 PDF/X 合规，也未嵌入虚构的输出条件。',
        '工艺蒙版使用 128 阈值转为二值，PDF 与 TIFF 共用相同的二值数据。',
        '合版 PDF 的专色按通道合并，供读版核对。layers/ 保留各工艺层，请按印厂确认的工序交付。',
        '专色分版为实地二值蒙版，实际色号请查工艺单。压凸与压凹分版仅描述平面区域，模具结构及深度由印厂确认。',
    ]
    if any(min(page['dpi']) < 299 for page in page_reports):
        notices.append('部分卡面的有效分辨率低于 300 PPI，建议提升输出尺寸后重新导出。')
    report = {
        'schemaVersion': 1, 'engine': PRINT_ENGINE,
        'createdAt': datetime.now(timezone.utc).isoformat(), 'project': project,
        'profile': profile, 'artworkMode': 'vector' if vector else 'raster', 'spotNames': {key: names[key] for key in keys},
        'verificationStatus': 'software-structure-checked', 'productionApproved': False,
        'checks': ['尺寸与正反面对齐', 'PDF 页数与 TrimBox', '专色名称与叠印属性', 'TIFF 二值数据往返一致',
                   '独立刀模 CutContour 与成品框', '工艺单与实际分版对应'],
        'pages': page_reports, 'notices': notices, 'documentPreflight': findings,
    }
    if factory:
        report['factoryProfile'] = factory
    files['preflight-report.json'] = json_bytes(report)
    instructions = [
        '典藏卡技术打样文件', '', f"项目  {project['name']}", f"源版本  {project['version']:g}",
        f"成品  {project['widthMm']:g} × {project['heightMm']:g} mm",
        f"出血  四周 {project['bleedMm']:g} mm", *stock_details_text(project),
        '页序  ' + '、'.join('正面' if page['side'] == 'front' else '背面' for page in pages), '',
        ('artwork.pdf 为基础矢量彩稿。' if vector else 'artwork.pdf 为 CMYK 彩稿。') + 'composite.pdf 为彩稿与命名专色合版。',
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
        **({'cardId': project['cardId']} if 'cardId' in project else {}),
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

    def project_workspace(self):
        community = getattr(self.server, 'community', None)
        from community_store import session_token
        token = session_token(self.headers)
        user = None
        if community and token:
            with community.connection() as db:
                user = community.user(db, token)
        self.workspace_scope = user['id'] if user else 'guest'
        if not user:
            raise ProjectError('登录已过期，请重新登录' if token else '请先登录', 401)
        scope = self.workspace_scope
        expected = self.headers.get('X-Prism-Workspace')
        if expected and expected != scope:
            raise ProjectError('工作区已切换，请重新打开项目', 409)
        self.workspace_user = dict(user)
        with self.server.workspace_lock:
            if scope not in self.server.account_stores:
                stores = self.server.account_stores
                if len(stores) >= 32:
                    stores.pop(next(iter(stores)))
                stores[scope] = ProjectStore(self.server.data_directory / 'accounts' / scope / 'projects.sqlite3')
            return self.server.account_stores[scope]

    def origin_allowed(self):
        origin = self.headers.get('Origin')
        public = getattr(self.server, 'public_origin', None)
        if public:
            return (self.headers.get('Host') == urlsplit(public).netloc and
                    (not origin or origin == public))
        if not origin:
            return True
        parsed = urlsplit(origin)
        return parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1')

    def respond(self, status, body, content_type='application/json; charset=utf-8', disposition=None):
        self.send_response(status)
        if self.origin_allowed() and self.headers.get('Origin'):
            self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        if hasattr(self, 'workspace_scope'):
            self.send_header('X-Prism-Workspace', self.workspace_scope)
        self.send_header('X-Content-Type-Options', 'nosniff')
        if disposition or content_type == 'application/zip':
            self.send_header('Content-Disposition', disposition or 'attachment; filename="card-print-package.zip"')
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
        elif path in ('/api/lan', '/api/lan/certificate'):
            if getattr(self.server, 'public_origin', None):
                self.respond(404, json_bytes({'error': '局域网接力仅在本机工作台提供'}))
                return
            from lan_access import manage_lan
            manage_lan(self)
        elif path == '/api/health':
            self.respond(200, json_bytes({'status': 'ok', 'engine': PRINT_ENGINE,
                                         'profiles': SPOT_PROFILES, 'layeredPlates': True,
                                         'productionOrder': True, 'productionApproved': False}))
        elif path.startswith('/api/community/'):
            from community_store import serve_community
            serve_community(self)
        elif path == '/api/card-assets' or path.startswith('/api/card-assets/'):
            from card_asset_store import handle_card_assets
            handle_card_assets(self, path, MAX_PROJECT_REQUEST_BYTES)
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
            store = self.project_workspace()
            if method == 'GET' and path == '/api/projects':
                self.respond(200, json_bytes(store.list()))
                return
            if len(parts) not in (4, 5, 6) or not PROJECT_ID.fullmatch(parts[3]):
                raise ProjectError('项目地址无效', 404)
            project_id = parts[3]
            if method == 'GET' and len(parts) == 4:
                result = store.get(project_id)
            elif method == 'GET' and len(parts) == 5 and parts[4] == 'deliveries':
                result = store.deliveries(project_id)
            elif method == 'GET' and len(parts) == 6 and parts[4] == 'deliveries' and PROJECT_ID.fullmatch(parts[5]):
                self.respond(200, store.delivery_source(project_id, parts[5]), 'application/octet-stream')
                return
            elif method == 'POST' and (len(parts) == 4 or (len(parts) == 5 and parts[4] in ('archive', 'deliveries', 'asset-use'))):
                if self.headers.get_content_type() != 'application/json':
                    raise ProjectError('请发送 JSON 项目数据')
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                except ValueError as error:
                    raise ProjectError('无效的项目大小') from error
                maximum = 4096 if len(parts) == 5 and parts[4] == 'asset-use' else MAX_PROJECT_REQUEST_BYTES
                if not 0 < length <= maximum:
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
                if len(parts) == 4:
                    result = store.save(project_id, payload)
                elif parts[4] == 'deliveries':
                    result = store.save_delivery(project_id, payload)
                elif parts[4] == 'asset-use':
                    result = self.record_asset_use(store, project_id, payload)
                else:
                    result = store.archive(project_id, payload)
            else:
                raise ProjectError('项目接口不存在', 404)
            self.respond(200, json_bytes(result))
        except ProjectError as error:
            self.respond(error.status, json_bytes({'error': str(error)}))
        except (sqlite3.Error, OSError) as error:
            self.log_error('Project storage: %s', error)
            self.respond(503, json_bytes({'error': '本机项目库暂时无法读写，请保留当前窗口并重试'}))

    def record_asset_use(self, store, project_id, payload):
        from asset_packages import event

        actor = self.workspace_scope
        community = getattr(self.server, 'community', None)
        if actor in ('guest', 'lan') or not community:
            raise ProjectError('请登录账号', 401)
        source = payload.get('source')
        card_id = payload.get('cardId')
        if not isinstance(source, dict) or not isinstance(card_id, str) or not 0 < len(card_id) <= 302:
            raise ProjectError('资产使用数据无效')
        kind = source.get('kind')
        if kind not in ('owned', 'received'):
            raise ProjectError('资产来源无效')
        owned = kind == 'owned'
        item = source.get('asset' if owned else 'work')
        version = source.get('assetVersion' if owned else 'edition')
        if not isinstance(item, str) or not PROJECT_ID.fullmatch(item) or type(version) is not int or not 0 < version < 2**31:
            raise ProjectError('资产版本无效')
        document = store.get(project_id)['project']
        card = document if document.get('cardId') == card_id else next((
            member for member in document.get('additionalCards', []) if member.get('id') == card_id), None)
        origin = card.get('assetOrigin' if owned else 'communityOrigin') if card else None
        if (not isinstance(origin, dict) or origin.get('assetId' if owned else 'workId') != item
                or origin.get('version' if owned else 'edition') != version):
            raise ProjectError('项目卡牌与资产来源不匹配', 409)
        if owned:
            with store.connection() as db:
                found = db.execute('SELECT 1 FROM card_asset_versions WHERE asset=? AND version=?', (item, version)).fetchone()
            if not found or origin.get('authorId') != actor:
                raise ProjectError('找不到该账号的资产版本', 404)
        with community.connection(True) as db:
            if not owned and not db.execute('SELECT 1 FROM holdings WHERE uid=? AND work=? AND edition=?',
                                            (actor, item, version)).fetchone():
                raise ProjectError('请先将该版本复制到自己的资产', 403)
            event(db, 'use', actor, 'asset:' + item if owned else item, version)
        return {'recorded': True}

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
        if path == '/api/lan':
            if getattr(self.server, 'public_origin', None):
                self.respond(404, json_bytes({'error': '局域网接力仅在本机工作台提供'}))
                return
            from lan_access import manage_lan
            manage_lan(self)
            return
        if path.startswith('/api/community/'):
            from community_store import serve_community
            serve_community(self)
            return
        if path.startswith('/api/card-assets/'):
            from card_asset_store import handle_card_assets
            handle_card_assets(self, path, MAX_PROJECT_REQUEST_BYTES)
            return
        if path.startswith('/api/projects/'):
            self.handle_projects(path)
            return
        if path != '/api/export':
            self.respond(404, json_bytes({'error': '接口不存在'}))
            return
        try:
            self.project_workspace()
        except ProjectError as error:
            self.respond(error.status, json_bytes({'error': str(error)}))
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
            shared_id = getattr(self.server, 'shared_project_id', None)
            if shared_id is not None and (not isinstance(payload, dict) or not isinstance(payload.get('project'), dict)
                                          or payload['project'].get('id') != shared_id):
                self.respond(403, json_bytes({'error': '仅可导出当前共享的项目。'}))
                return
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
    parser.add_argument('--host', default='127.0.0.1', help='HTTP bind address (defaults to 127.0.0.1)')
    parser.add_argument('--port', type=int, default=4174)
    parser.add_argument('--data-dir', type=Path)
    parser.add_argument('--public-origin', help='HTTPS origin of a same-origin reverse proxy for an account-based workspace')
    args = parser.parse_args()
    if args.public_origin:
        origin = urlsplit(args.public_origin)
        if origin.scheme != 'https' or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment or origin.path not in ('','/'):
            parser.error('--public-origin requires an HTTPS origin without credentials or a path')
        args.public_origin = 'https://' + origin.netloc
    elif args.host != '127.0.0.1':
        parser.error('--public-origin is required when binding beyond 127.0.0.1')
    if not args.data_dir:
        base = Path.home() / 'Library' / 'Application Support'
        args.data_dir = base / ('Prism Hosted' if args.public_origin else 'Prism')
    data_directory = args.data_dir.expanduser()
    data_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.data_directory = data_directory
    server.public_origin = args.public_origin
    from lan_access import LanAccess
    server.lan = LanAccess(Handler, data_directory / 'lan-tls')
    from community_store import CommunityStore
    server.community = CommunityStore(data_directory / 'community.sqlite3',
                                      public_origin=args.public_origin,
                                      local_origin=f'http://127.0.0.1:{server.server_port}')
    server.workspace_lock = threading.Lock()
    server.account_stores = {}
    server.daemon_threads = True
    print(f'Prism ready on http://{args.host}:{server.server_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.lan.stop()
        server.server_close()


if __name__ == '__main__':
    main()
