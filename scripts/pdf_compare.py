#!/usr/bin/env python3
"""
pdf_compare.py — Deep PDF analysis and comparison tool

Extracts granular per-page, per-image, and per-font data from PDF files.
In comparison mode, shows side-by-side deltas revealing how compression
tools differ in their approach.

Usage:
    python pdf_compare.py document.pdf
    python pdf_compare.py original.pdf smallpdf.pdf adobe.pdf ilovepdf.pdf
    python pdf_compare.py original.pdf compressed.pdf --json out.json

Requirements:
    pip install pikepdf pillow rich
"""

import sys
import json
import struct
import io
import math
import argparse
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field, asdict
from copy import deepcopy

try:
    import pikepdf
    from pikepdf import Pdf, Name, Array, Dictionary
except ImportError:
    sys.exit("Missing dependency: pip install pikepdf")

try:
    from rich.console import Console
    from rich.table import Table
    from rich.panel import Panel
    from rich.text import Text
    from rich import box
    console = Console()
except ImportError:
    sys.exit("Missing dependency: pip install rich")


# ══════════════════════════════════════════════════════════════════════════════
# Data structures
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class FileInfo:
    path: str
    size_bytes: int
    pdf_version: str
    linearized: bool
    encrypted: bool
    producer: str
    creator: str
    creation_date: str
    mod_date: str
    num_objects: int
    xref_type: str          # "table" or "stream"
    has_object_streams: bool
    has_xmp: bool
    xmp_bytes: int

@dataclass
class ImageInfo:
    object_id: str
    pages: list              # list of 1-indexed page numbers
    page_order: list         # (page, order_on_page) tuples for matching
    width_px: int
    height_px: int
    color_space: str
    num_components: int
    bits_per_component: int
    primary_filter: str
    all_filters: list
    compressed_bytes: int
    uncompressed_bytes: int  # -1 if couldn't decode
    compression_ratio: float
    dpi_x: Optional[float]
    dpi_y: Optional[float]
    jpeg_quality: Optional[int]
    has_soft_mask: bool
    smask_width: Optional[int]           # pixel width of SMask object
    smask_height: Optional[int]          # pixel height of SMask object
    smask_dimension_mismatch: bool       # True if SMask exists but dims don't match parent
    image_mask: bool         # 1-bit stencil mask
    interpolate: bool
    inline_count: int        # how many times used inline (rare)

@dataclass
class FontInfo:
    object_id: str
    name: str
    font_type: str
    subtype: str
    embedded: bool
    subsetted: bool          # subset prefix like "ABCDEF+FontName"
    stream_bytes: int
    pages: list

@dataclass
class PageInfo:
    page_num: int
    width_pts: float
    height_pts: float
    width_in: float
    height_in: float
    rotation: int
    content_compressed_bytes: int
    content_uncompressed_bytes: int
    num_images: int
    num_unique_image_refs: int
    num_fonts: int
    num_annotations: int
    num_form_xobjects: int
    image_names: list        # XObject resource names (/Im0, /Im1, etc.)

@dataclass
class PDFAnalysis:
    label: str
    file: FileInfo
    pages: list              # list[PageInfo]
    images: list             # list[ImageInfo]
    fonts: list              # list[FontInfo]
    warnings: list           # list of integrity warning strings
    # Aggregates
    total_image_bytes_compressed: int
    total_image_bytes_uncompressed: int
    total_font_bytes: int
    total_content_bytes_compressed: int
    total_content_bytes_uncompressed: int


# ══════════════════════════════════════════════════════════════════════════════
# JPEG quality estimation
# ══════════════════════════════════════════════════════════════════════════════

# Standard JPEG luminance quantization table at quality 50 (JPEG reference impl.)
_LUMA_BASE = [
    16, 11, 10, 16,  24,  40,  51,  61,
    12, 12, 14, 19,  26,  58,  60,  55,
    14, 13, 16, 24,  40,  57,  69,  56,
    14, 17, 22, 29,  51,  87,  80,  62,
    18, 22, 37, 56,  68, 109, 103,  77,
    24, 35, 55, 64,  81, 104, 113,  92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103,  99,
]


def estimate_jpeg_quality(jpeg_bytes: bytes) -> Optional[int]:
    """
    Estimate JPEG quality (1-100) by reading the DQT quantization table
    and reverse-engineering the JPEG reference implementation's quality formula.
    Returns None if no JPEG quantization table is found.
    """
    data = bytes(jpeg_bytes)
    i = 0
    while i < len(data) - 3:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker == 0xDB:  # DQT — Define Quantization Table
            length = struct.unpack('>H', data[i + 2:i + 4])[0]
            pos = i + 4
            end = i + 2 + length
            while pos < end - 1:
                prec_id = data[pos]
                table_id = prec_id & 0x0F
                precision = (prec_id >> 4) & 0x0F  # 0=8-bit, 1=16-bit
                pos += 1
                if table_id == 0:  # luminance table
                    if precision == 0:
                        table = list(data[pos:pos + 64])
                        pos += 64
                    else:
                        table = [struct.unpack('>H', data[pos + j*2:pos + j*2 + 2])[0]
                                 for j in range(64)]
                        pos += 128
                    # Compute average ratio vs. baseline at Q=50
                    ratios = [actual / base for actual, base
                              in zip(table, _LUMA_BASE) if base > 0 and actual > 0]
                    if not ratios:
                        return None
                    avg_ratio = sum(ratios) / len(ratios)
                    scale = avg_ratio * 100
                    if scale <= 100:
                        quality = int(5000 / scale) if scale > 0 else 100
                    else:
                        quality = int((200 - scale) / 2)
                    return max(1, min(100, quality))
                else:
                    # Skip this table
                    pos += 64 if precision == 0 else 128
            i += 2 + length
        elif marker in (0xD8, 0xD9, 0xE0, 0xE1, 0xFE):
            if marker in (0xD8, 0xD9):
                i += 2
            else:
                length = struct.unpack('>H', data[i + 2:i + 4])[0]
                i += 2 + length
        else:
            i += 1
    return None


# ══════════════════════════════════════════════════════════════════════════════
# Color space helpers
# ══════════════════════════════════════════════════════════════════════════════

def resolve_color_space(cs_obj, pdf: Pdf) -> tuple:
    """Returns (name: str, num_components: int)."""
    if cs_obj is None:
        return ("Unknown", 0)
    try:
        if isinstance(cs_obj, pikepdf.Name):
            name = str(cs_obj)
            components = {
                '/DeviceGray': 1, '/DeviceRGB': 3, '/DeviceCMYK': 4,
                '/G': 1, '/RGB': 3, '/CMYK': 4,
                '/Pattern': 0,
            }.get(name, 1)
            return (name.lstrip('/'), components)
        if isinstance(cs_obj, pikepdf.Array):
            cs_type = str(cs_obj[0])
            if cs_type == '/ICCBased':
                stream = pdf.get_object(cs_obj[1].objgen) if hasattr(cs_obj[1], 'objgen') else cs_obj[1]
                n = int(stream.stream_dict.get('/N', 3))
                return (f"ICCBased({n}ch)", n)
            if cs_type == '/Indexed':
                base_name, _ = resolve_color_space(cs_obj[1], pdf)
                return (f"Indexed({base_name})", 1)
            if cs_type in ('/CalRGB', '/Lab'):
                return (cs_type.lstrip('/'), 3)
            if cs_type == '/CalGray':
                return ('CalGray', 1)
            if cs_type == '/Separation':
                return ('Separation', 1)
            if cs_type == '/DeviceN':
                n = len(cs_obj[1]) if hasattr(cs_obj[1], '__len__') else 1
                return (f'DeviceN({n}ch)', n)
    except Exception:
        pass
    return (str(cs_obj)[:30], 0)


# ══════════════════════════════════════════════════════════════════════════════
# Content stream CTM tracker — extracts DPI for each image placement
# ══════════════════════════════════════════════════════════════════════════════

def get_image_placements(page) -> dict:
    """
    Parse a page's content stream tracking the CTM stack.
    Returns: { xobject_resource_name: [(width_pts, height_pts), ...] }
    One entry per `Do` invocation (same image can appear multiple times).
    """
    placements = {}

    def mat_mul(m1, m2):
        """Multiply two 6-element PDF matrices [a b c d e f]."""
        a1, b1, c1, d1, e1, f1 = m1
        a2, b2, c2, d2, e2, f2 = m2
        return [
            a1*a2 + b1*c2,
            a1*b2 + b1*d2,
            c1*a2 + d1*c2,
            c1*b2 + d1*d2,
            e1*a2 + f1*c2 + e2,
            e1*b2 + f1*d2 + f2,
        ]

    identity = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    ctm_stack = [identity[:]]

    try:
        for operands, operator in pikepdf.parse_content_stream(page):
            op = str(operator)
            if op == 'q':
                ctm_stack.append(ctm_stack[-1][:])
            elif op == 'Q':
                if len(ctm_stack) > 1:
                    ctm_stack.pop()
            elif op == 'cm':
                vals = [float(x) for x in operands]
                if len(vals) == 6:
                    new_ctm = mat_mul(ctm_stack[-1], vals)
                    ctm_stack[-1] = new_ctm
            elif op == 'Do':
                name = str(operands[0])
                a, b, c, d, _, _ = ctm_stack[-1]
                # Effective width/height in user units (points)
                w = math.sqrt(a*a + b*b)
                h = math.sqrt(c*c + d*d)
                placements.setdefault(name, []).append((w, h))
    except Exception:
        pass  # malformed content stream — skip DPI calc

    return placements


# ══════════════════════════════════════════════════════════════════════════════
# Filter helpers
# ══════════════════════════════════════════════════════════════════════════════

def get_filters(stream_dict) -> list:
    """Return list of filter names as clean strings."""
    f = stream_dict.get('/Filter')
    if f is None:
        return []
    if isinstance(f, pikepdf.Name):
        return [str(f).lstrip('/')]
    if isinstance(f, pikepdf.Array):
        return [str(x).lstrip('/') for x in f]
    return [str(f).lstrip('/')]


def primary_filter(filters: list) -> str:
    """Return the most meaningful filter (skip encoding-only filters)."""
    skip = {'ASCII85Decode', 'ASCIIHexDecode'}
    for f in reversed(filters):  # innermost filter is applied last
        if f not in skip:
            return f
    return filters[0] if filters else 'None'


# ══════════════════════════════════════════════════════════════════════════════
# Main analysis
# ══════════════════════════════════════════════════════════════════════════════

def analyze_pdf(path: Path, label: str = None) -> PDFAnalysis:
    label = label or path.name
    console.print(f"  Analyzing [bold]{label}[/bold]...", end=" ")

    pdf = Pdf.open(path)
    file_size = path.stat().st_size

    # ── File info ─────────────────────────────────────────────────────────────
    info_dict = pdf.docinfo
    producer = str(info_dict.get('/Producer', '')).strip()
    creator  = str(info_dict.get('/Creator',  '')).strip()
    cdate    = str(info_dict.get('/CreationDate', '')).strip()
    mdate    = str(info_dict.get('/ModDate', '')).strip()

    linearized = '/Linearized' in pdf.trailer
    encrypted  = pdf.is_encrypted
    version    = f"{pdf.pdf_version}"

    # XMP
    has_xmp, xmp_bytes = False, 0
    try:
        if hasattr(pdf, 'open_metadata'):
            meta = pdf.open_metadata()
            xmp_raw = bytes(meta._xmp) if hasattr(meta, '_xmp') and meta._xmp else b''
            if xmp_raw:
                has_xmp = True
                xmp_bytes = len(xmp_raw)
    except Exception:
        pass

    # Object/xref info
    num_objects = 0
    has_object_streams = False
    xref_type = 'table'
    try:
        xref = pdf.trailer.get('/XRef') or pdf.trailer
        if '/W' in pdf.trailer or pdf.trailer.get('/Type') == Name('/XRef'):
            xref_type = 'stream'

        for objnum in pdf.objects:
            num_objects += 1
            try:
                obj = pdf.get_object(objnum.objgen if hasattr(objnum, 'objgen') else (objnum, 0))
                if hasattr(obj, 'stream_dict'):
                    if str(obj.stream_dict.get('/Type', '')) == '/ObjStm':
                        has_object_streams = True
            except Exception:
                pass
    except Exception:
        pass

    # ── Image XObjects (global scan) ──────────────────────────────────────────
    # Collect all Image XObjects in document and which pages reference them
    image_by_objid: dict = {}   # objid_str → ImageInfo partial
    image_objgen_to_id: dict = {}

    # First pass: find all XObject images
    for objnum in pdf.objects:
        try:
            objgen = objnum.objgen if hasattr(objnum, 'objgen') else (int(str(objnum)), 0)
            obj = pdf.get_object(objgen)
            if not hasattr(obj, 'stream_dict'):
                continue
            sd = obj.stream_dict
            if str(sd.get('/Type', '')) != '/XObject':
                continue
            if str(sd.get('/Subtype', '')) != '/Image':
                continue

            objid = f"{objgen[0]}:{objgen[1]}"
            image_objgen_to_id[objgen] = objid

            w = int(sd.get('/Width', 0))
            h = int(sd.get('/Height', 0))
            bpc = int(sd.get('/BitsPerComponent', 8))
            cs_raw = sd.get('/ColorSpace')
            cs_name, n_comp = resolve_color_space(cs_raw, pdf)
            filters = get_filters(sd)
            pf = primary_filter(filters)
            has_mask = sd.get('/ImageMask', False) is pikepdf.Boolean(True) or \
                       str(sd.get('/ImageMask', 'false')).lower() == 'true'
            has_smask = '/SMask' in sd
            interpolate = str(sd.get('/Interpolate', 'false')).lower() == 'true'

            # SMask dimension lookup
            smask_width = None
            smask_height = None
            smask_mismatch = False
            if has_smask:
                try:
                    smask_ref = sd.get('/SMask')
                    if smask_ref is not None and hasattr(smask_ref, 'objgen'):
                        smask_obj = pdf.get_object(smask_ref.objgen)
                        if hasattr(smask_obj, 'stream_dict'):
                            smask_sd = smask_obj.stream_dict
                            smask_width = int(smask_sd.get('/Width', 0)) or None
                            smask_height = int(smask_sd.get('/Height', 0)) or None
                            if smask_width is not None and smask_height is not None:
                                if smask_width != w or smask_height != h:
                                    smask_mismatch = True
                except Exception:
                    pass

            # Stream sizes
            compressed_bytes = 0
            uncompressed_bytes = -1
            try:
                raw = obj.read_raw_bytes()
                compressed_bytes = len(raw)
                if pf in ('DCTDecode', 'JPXDecode'):
                    uncompressed_bytes = w * h * max(n_comp, 1) * max(bpc, 8) // 8
                else:
                    decoded = obj.read_bytes()
                    uncompressed_bytes = len(decoded)
            except Exception:
                uncompressed_bytes = w * h * max(n_comp, 1) * max(bpc, 8) // 8
                if uncompressed_bytes == 0:
                    uncompressed_bytes = -1

            # JPEG quality
            jpeg_quality = None
            if pf == 'DCTDecode':
                try:
                    raw_bytes = obj.read_raw_bytes()
                    jpeg_quality = estimate_jpeg_quality(bytes(raw_bytes))
                except Exception:
                    pass

            ratio = (compressed_bytes / uncompressed_bytes) if uncompressed_bytes > 0 else 0.0

            image_by_objid[objid] = ImageInfo(
                object_id=objid,
                pages=[],
                page_order=[],
                width_px=w,
                height_px=h,
                color_space=cs_name,
                num_components=n_comp,
                bits_per_component=bpc,
                primary_filter=pf,
                all_filters=filters,
                compressed_bytes=compressed_bytes,
                uncompressed_bytes=uncompressed_bytes,
                compression_ratio=ratio,
                dpi_x=None,
                dpi_y=None,
                jpeg_quality=jpeg_quality,
                has_soft_mask=has_smask,
                smask_width=smask_width,
                smask_height=smask_height,
                smask_dimension_mismatch=smask_mismatch,
                image_mask=has_mask,
                interpolate=interpolate,
                inline_count=0,
            )
        except Exception:
            continue

    # ── Per-page analysis ─────────────────────────────────────────────────────
    pages_info = []
    font_by_objid: dict = {}
    font_objgen_to_id: dict = {}

    for page_num, page in enumerate(pdf.pages, 1):
        # Dimensions
        mb = page.mediabox
        try:
            x0, y0, x1, y1 = float(mb[0]), float(mb[1]), float(mb[2]), float(mb[3])
            w_pts = abs(x1 - x0)
            h_pts = abs(y1 - y0)
        except Exception:
            w_pts, h_pts = 0.0, 0.0
        rot = int(str(page.get('/Rotate', 0)))

        # Content stream sizes
        content_comp = 0
        content_uncomp = 0
        try:
            cs = page.get('/Contents')
            if cs is not None:
                streams = [cs] if not isinstance(cs, pikepdf.Array) else list(cs)
                for s in streams:
                    try:
                        obj = pdf.get_object(s.objgen if hasattr(s, 'objgen') else s)
                        content_comp += len(obj.read_raw_bytes())
                        content_uncomp += len(obj.read_bytes())
                    except Exception:
                        pass
        except Exception:
            pass

        # Image XObject references on this page
        image_names_on_page = []
        image_placements = {}
        try:
            resources = page.get('/Resources', Dictionary())
            xobjs = resources.get('/XObject', Dictionary())
            if isinstance(xobjs, pikepdf.Dictionary):
                for name, ref in xobjs.items():
                    try:
                        objgen = ref.objgen if hasattr(ref, 'objgen') else None
                        if objgen is None:
                            continue
                        obj = pdf.get_object(objgen)
                        if not hasattr(obj, 'stream_dict'):
                            continue
                        if str(obj.stream_dict.get('/Subtype', '')) == '/Image':
                            image_names_on_page.append(str(name))
                            objid = image_objgen_to_id.get(objgen)
                            if objid and objid in image_by_objid:
                                img = image_by_objid[objid]
                                if page_num not in img.pages:
                                    img.pages.append(page_num)
                                img.page_order.append((page_num, len(img.page_order)))
                    except Exception:
                        continue
        except Exception:
            pass

        # DPI: parse content stream for cm + Do
        try:
            image_placements = get_image_placements(page)
            resources = page.get('/Resources', Dictionary())
            xobjs = resources.get('/XObject', Dictionary())
            if isinstance(xobjs, pikepdf.Dictionary):
                for res_name, ref in xobjs.items():
                    try:
                        objgen = ref.objgen if hasattr(ref, 'objgen') else None
                        if objgen is None:
                            continue
                        objid = image_objgen_to_id.get(objgen)
                        if not objid or objid not in image_by_objid:
                            continue
                        img = image_by_objid[objid]
                        pts_list = image_placements.get(str(res_name), [])
                        for w_pts_place, h_pts_place in pts_list:
                            if w_pts_place > 0 and h_pts_place > 0 and img.width_px > 0:
                                dpi_x = img.width_px / (w_pts_place / 72.0)
                                dpi_y = img.height_px / (h_pts_place / 72.0)
                                if img.dpi_x is None:
                                    img.dpi_x = round(dpi_x, 1)
                                    img.dpi_y = round(dpi_y, 1)
                    except Exception:
                        continue
        except Exception:
            pass

        # Fonts on this page
        num_fonts = 0
        try:
            resources = page.get('/Resources', Dictionary())
            font_dict = resources.get('/Font', Dictionary())
            if isinstance(font_dict, pikepdf.Dictionary):
                for fname, fref in font_dict.items():
                    num_fonts += 1
                    try:
                        objgen = fref.objgen if hasattr(fref, 'objgen') else None
                        if objgen is None:
                            continue
                        objid = f"{objgen[0]}:{objgen[1]}"
                        if objid in font_by_objid:
                            if page_num not in font_by_objid[objid].pages:
                                font_by_objid[objid].pages.append(page_num)
                            continue
                        fobj = pdf.get_object(objgen)
                        f_type  = str(fobj.get('/Type', '')).lstrip('/')
                        f_sub   = str(fobj.get('/Subtype', '')).lstrip('/')
                        f_name  = str(fobj.get('/BaseFont', fobj.get('/Name', ''))).lstrip('/')

                        # Detect subsetting: subset fonts have "ABCDEF+Name" prefix
                        subsetted = len(f_name) > 7 and f_name[6] == '+' and f_name[:6].isupper()

                        # Find embedded font stream
                        embedded = False
                        stream_bytes = 0
                        descriptor = fobj.get('/FontDescriptor')
                        if descriptor is not None:
                            try:
                                desc_obj = pdf.get_object(descriptor.objgen) \
                                    if hasattr(descriptor, 'objgen') else descriptor
                                for stream_key in ('/FontFile', '/FontFile2', '/FontFile3'):
                                    ff = desc_obj.get(stream_key)
                                    if ff is not None:
                                        embedded = True
                                        try:
                                            ff_obj = pdf.get_object(ff.objgen) \
                                                if hasattr(ff, 'objgen') else ff
                                            stream_bytes = len(ff_obj.read_raw_bytes())
                                        except Exception:
                                            pass
                                        break
                            except Exception:
                                pass

                        font_by_objid[objid] = FontInfo(
                            object_id=objid,
                            name=f_name,
                            font_type=f_type,
                            subtype=f_sub,
                            embedded=embedded,
                            subsetted=subsetted,
                            stream_bytes=stream_bytes,
                            pages=[page_num],
                        )
                    except Exception:
                        continue
        except Exception:
            pass

        # Annotations
        num_annots = 0
        try:
            annots = page.get('/Annots')
            if annots is not None:
                num_annots = len(list(annots)) if isinstance(annots, pikepdf.Array) else 1
        except Exception:
            pass

        # Form XObjects
        num_forms = 0
        try:
            resources = page.get('/Resources', Dictionary())
            xobjs = resources.get('/XObject', Dictionary())
            if isinstance(xobjs, pikepdf.Dictionary):
                for _, ref in xobjs.items():
                    try:
                        objgen = ref.objgen if hasattr(ref, 'objgen') else None
                        if objgen is None:
                            continue
                        obj = pdf.get_object(objgen)
                        if hasattr(obj, 'stream_dict') and \
                           str(obj.stream_dict.get('/Subtype', '')) == '/Form':
                            num_forms += 1
                    except Exception:
                        pass
        except Exception:
            pass

        pages_info.append(PageInfo(
            page_num=page_num,
            width_pts=round(w_pts, 2),
            height_pts=round(h_pts, 2),
            width_in=round(w_pts / 72, 3),
            height_in=round(h_pts / 72, 3),
            rotation=rot,
            content_compressed_bytes=content_comp,
            content_uncompressed_bytes=content_uncomp,
            num_images=len(image_names_on_page),
            num_unique_image_refs=len(set(image_names_on_page)),
            num_fonts=num_fonts,
            num_annotations=num_annots,
            num_form_xobjects=num_forms,
            image_names=image_names_on_page,
        ))

    images_list  = list(image_by_objid.values())
    fonts_list   = list(font_by_objid.values())

    # ── Integrity checks ──────────────────────────────────────────────────────
    integrity_warnings = []
    for img in images_list:
        if img.compressed_bytes > 0 and img.uncompressed_bytes >= 1000 and \
                img.compressed_bytes > img.uncompressed_bytes:
            ratio = img.compressed_bytes / img.uncompressed_bytes
            integrity_warnings.append(
                f"Object {img.object_id}: impossible compression ratio {ratio:.2f}x "
                f"(compressed {fmt_bytes(img.compressed_bytes)} > uncompressed {fmt_bytes(img.uncompressed_bytes)})"
            )
        if img.compressed_bytes == 0 and img.width_px > 0 and img.height_px > 0 and not img.image_mask:
            integrity_warnings.append(
                f"Object {img.object_id}: zero-byte image stream (stripped?) "
                f"for {img.width_px}×{img.height_px} image"
            )
        if img.bits_per_component not in (1, 8, 16) and img.bits_per_component > 0:
            integrity_warnings.append(
                f"Object {img.object_id}: unusual BitsPerComponent={img.bits_per_component}"
            )
        if img.smask_dimension_mismatch:
            integrity_warnings.append(
                f"Object {img.object_id}: SMask dimensions {img.smask_width}×{img.smask_height} "
                f"don't match image {img.width_px}×{img.height_px} — Acrobat will error"
            )

    # Aggregates
    total_img_comp   = sum(i.compressed_bytes for i in images_list)
    total_img_uncomp = sum(i.uncompressed_bytes for i in images_list if i.uncompressed_bytes > 0)
    total_font       = sum(f.stream_bytes for f in fonts_list)
    total_cont_comp  = sum(p.content_compressed_bytes for p in pages_info)
    total_cont_uncomp= sum(p.content_uncompressed_bytes for p in pages_info)

    file_info = FileInfo(
        path=str(path),
        size_bytes=file_size,
        pdf_version=version,
        linearized=linearized,
        encrypted=encrypted,
        producer=producer,
        creator=creator,
        creation_date=cdate,
        mod_date=mdate,
        num_objects=num_objects,
        xref_type=xref_type,
        has_object_streams=has_object_streams,
        has_xmp=has_xmp,
        xmp_bytes=xmp_bytes,
    )

    console.print("[green]done[/green]")
    return PDFAnalysis(
        label=label,
        file=file_info,
        pages=pages_info,
        images=images_list,
        fonts=fonts_list,
        warnings=integrity_warnings,
        total_image_bytes_compressed=total_img_comp,
        total_image_bytes_uncompressed=total_img_uncomp,
        total_font_bytes=total_font,
        total_content_bytes_compressed=total_cont_comp,
        total_content_bytes_uncompressed=total_cont_uncomp,
    )


# ══════════════════════════════════════════════════════════════════════════════
# Formatting helpers
# ══════════════════════════════════════════════════════════════════════════════

def fmt_bytes(b: int, prec: int = 1) -> str:
    if b < 0:
        return "N/A"
    if b < 1024:
        return f"{b} B"
    if b < 1024 ** 2:
        return f"{b/1024:.{prec}f} KB"
    return f"{b/1024**2:.{prec}f} MB"

def fmt_pct(val: float) -> str:
    return f"{val:.1f}%"

def delta_pct(new_val: int, orig_val: int) -> str:
    if orig_val <= 0:
        return ""
    pct = (new_val - orig_val) / orig_val * 100
    sign = "+" if pct > 0 else ""
    return f"({sign}{pct:.0f}%)"

def bool_str(v: bool) -> str:
    return "[green]yes[/green]" if v else "[red]no[/red]"

def nullable(v, fmt=str, none_str="—") -> str:
    return none_str if v is None else fmt(v)

def fmt_filters(img: "ImageInfo") -> str:
    """Show filter chain as FlateDecode+DCTDecode for array filters."""
    if len(img.all_filters) > 1:
        return "+".join(img.all_filters)
    return img.primary_filter or "None"


# ══════════════════════════════════════════════════════════════════════════════
# Single-file output
# ══════════════════════════════════════════════════════════════════════════════

def print_single(analysis: PDFAnalysis):
    f = analysis.file
    console.rule(f"[bold cyan]{analysis.label}[/bold cyan]")

    # File summary
    t = Table(show_header=False, box=box.SIMPLE, padding=(0, 1))
    t.add_column("key",   style="dim", width=28)
    t.add_column("value", style="bold")
    rows = [
        ("File size",         fmt_bytes(f.size_bytes)),
        ("PDF version",       f.pdf_version),
        ("Pages",             str(len(analysis.pages))),
        ("Images",            str(len(analysis.images))),
        ("Fonts",             str(len(analysis.fonts))),
        ("Objects",           str(f.num_objects)),
        ("XRef type",         f.xref_type),
        ("Object streams",    "yes" if f.has_object_streams else "no"),
        ("XMP metadata",      f"yes ({fmt_bytes(f.xmp_bytes)})" if f.has_xmp else "no"),
        ("Linearized",        "yes" if f.linearized else "no"),
        ("Encrypted",         "yes" if f.encrypted else "no"),
        ("Producer",          f.producer or "—"),
        ("Creator",           f.creator or "—"),
        ("Total image bytes", fmt_bytes(analysis.total_image_bytes_compressed)),
        ("Total font bytes",  fmt_bytes(analysis.total_font_bytes)),
        ("Total content bytes", fmt_bytes(analysis.total_content_bytes_compressed)),
    ]
    for k, v in rows:
        t.add_row(k, v)
    console.print(Panel(t, title="[bold]File Summary[/bold]", expand=False))

    # Per-page table
    pt = Table(title="Per-Page Analysis", box=box.SIMPLE_HEAD, show_lines=False)
    for col in ["Page", "Size (pts)", "Size (in)", "Rot", "Images", "Fonts", "Annots",
                "Content (comp)", "Content (raw)", "Form XObjs"]:
        pt.add_column(col, justify="right" if col not in ("Size (pts)", "Size (in)") else "left")
    for p in analysis.pages:
        pt.add_row(
            str(p.page_num),
            f"{p.width_pts:.0f}×{p.height_pts:.0f}",
            f"{p.width_in:.2f}×{p.height_in:.2f}",
            str(p.rotation) if p.rotation else "0",
            str(p.num_images),
            str(p.num_fonts),
            str(p.num_annotations),
            fmt_bytes(p.content_compressed_bytes),
            fmt_bytes(p.content_uncompressed_bytes),
            str(p.num_form_xobjects),
        )
    console.print(pt)

    # Per-image table
    if analysis.images:
        it = Table(title="Per-Image Analysis", box=box.SIMPLE_HEAD, show_lines=False)
        for col in ["ObjID", "Pages", "W×H (px)", "ColorSpace", "BPC", "Filter",
                    "JPEG Q", "DPI", "Compressed", "Uncompressed", "Ratio",
                    "SMask", "Mask", "Interp"]:
            it.add_column(col)
        for img in sorted(analysis.images, key=lambda x: (x.pages[0] if x.pages else 0, x.object_id)):
            dpi_str = f"{img.dpi_x:.0f}×{img.dpi_y:.0f}" if img.dpi_x else "—"
            ratio_str = f"{img.compression_ratio:.3f}" if img.compression_ratio > 0 else "—"
            # SMask column: show dimensions and flag mismatches
            if not img.has_soft_mask:
                smask_str = ""
            elif img.smask_dimension_mismatch:
                smask_str = f"[bold red]{img.smask_width}×{img.smask_height} ✗[/bold red]"
            elif img.smask_width is not None:
                smask_str = f"{img.smask_width}×{img.smask_height}"
            else:
                smask_str = "✓"
            it.add_row(
                img.object_id,
                ",".join(str(p) for p in img.pages) or "?",
                f"{img.width_px}×{img.height_px}",
                img.color_space,
                str(img.bits_per_component),
                fmt_filters(img),
                str(img.jpeg_quality) if img.jpeg_quality else "—",
                dpi_str,
                fmt_bytes(img.compressed_bytes),
                fmt_bytes(img.uncompressed_bytes),
                ratio_str,
                smask_str,
                "✓" if img.image_mask else "",
                "✓" if img.interpolate else "",
            )
        console.print(it)

    # Integrity warnings panel
    if analysis.warnings:
        lines = []
        for w in analysis.warnings:
            if "Acrobat" in w or "impossible" in w or "zero-byte" in w:
                lines.append(f"[bold red]⚠ {w}[/bold red]")
            else:
                lines.append(f"[yellow]⚠ {w}[/yellow]")
        console.print(Panel("\n".join(lines), title="[bold yellow]⚠ Integrity Warnings[/bold yellow]", expand=False))

    # Per-font table
    if analysis.fonts:
        ft = Table(title="Per-Font Analysis", box=box.SIMPLE_HEAD, show_lines=False)
        for col in ["ObjID", "Name", "Type", "Subtype", "Embedded", "Subsetted",
                    "Stream", "Pages"]:
            ft.add_column(col)
        for font in sorted(analysis.fonts, key=lambda x: (x.pages[0] if x.pages else 0, x.name)):
            ft.add_row(
                font.object_id,
                font.name[:40],
                font.font_type,
                font.subtype,
                "✓" if font.embedded else "✗",
                "✓" if font.subsetted else "",
                fmt_bytes(font.stream_bytes) if font.embedded else "—",
                ",".join(str(p) for p in font.pages) or "?",
            )
        console.print(ft)


# ══════════════════════════════════════════════════════════════════════════════
# Comparison output
# ══════════════════════════════════════════════════════════════════════════════

def print_comparison(analyses: list):
    orig = analyses[0]
    rest = analyses[1:]
    labels = [a.label for a in analyses]

    # ── File-level summary ────────────────────────────────────────────────────
    console.rule("[bold cyan]File-Level Summary[/bold cyan]")
    t = Table(box=box.SIMPLE_HEAD, show_lines=False)
    t.add_column("Metric", style="dim", width=28)
    for lbl in labels:
        t.add_column(lbl, justify="right")

    def row(name, fn):
        vals = [fn(a) for a in analyses]
        cells = [vals[0]]
        for i, v in enumerate(vals[1:], 1):
            cells.append(v)
        t.add_row(name, *cells)

    def size_row(name, getter):
        vals = [getter(a) for a in analyses]
        orig_v = vals[0]
        cells = []
        for i, v in enumerate(vals):
            s = fmt_bytes(v)
            if i > 0 and orig_v > 0:
                pct = (v - orig_v) / orig_v * 100
                color = "green" if pct < 0 else "red" if pct > 0 else "white"
                sign = "+" if pct > 0 else ""
                s += f" [{color}]({sign}{pct:.0f}%)[/{color}]"
            cells.append(s)
        t.add_row(name, *cells)

    size_row("File size",              lambda a: a.file.size_bytes)
    t.add_row("PDF version",           *[a.file.pdf_version for a in analyses])
    t.add_row("# Pages",               *[str(len(a.pages)) for a in analyses])
    t.add_row("# Images",              *[str(len(a.images)) for a in analyses])
    t.add_row("# Fonts",               *[str(len(a.fonts)) for a in analyses])
    t.add_row("# Objects",             *[str(a.file.num_objects) for a in analyses])
    t.add_row("XRef type",             *[a.file.xref_type for a in analyses])
    t.add_row("Object streams",        *["yes" if a.file.has_object_streams else "no" for a in analyses])
    t.add_row("XMP metadata",          *["yes" if a.file.has_xmp else "no" for a in analyses])
    t.add_row("Linearized",            *["yes" if a.file.linearized else "no" for a in analyses])
    t.add_row("Producer",              *[(a.file.producer or "—")[:30] for a in analyses])
    size_row("Total image bytes",      lambda a: a.total_image_bytes_compressed)
    size_row("Total font bytes",       lambda a: a.total_font_bytes)
    size_row("Total content bytes",    lambda a: a.total_content_bytes_compressed)
    console.print(t)

    # ── Per-page comparison ───────────────────────────────────────────────────
    console.rule("[bold cyan]Per-Page Comparison[/bold cyan]")
    num_pages = max(len(a.pages) for a in analyses)
    for pg in range(num_pages):
        rows_data = []
        page_rows = [a.pages[pg] if pg < len(a.pages) else None for a in analyses]
        if all(p is None for p in page_rows):
            continue
        orig_pg = page_rows[0]

        pt = Table(title=f"Page {pg + 1}", box=box.SIMPLE_HEAD, show_lines=False)
        pt.add_column("Metric", style="dim", width=22)
        for lbl in labels:
            pt.add_column(lbl, justify="right")

        def pg_row(name, fn, color_fn=None):
            vals = [fn(p) if p else "—" for p in page_rows]
            cells = list(vals)
            pt.add_row(name, *[str(c) for c in cells])

        if orig_pg:
            pt.add_row("Dimensions (pts)",
                *[f"{p.width_pts:.0f}×{p.height_pts:.0f}" if p else "—" for p in page_rows])
            pt.add_row("Dimensions (in)",
                *[f"{p.width_in:.2f}×{p.height_in:.2f}" if p else "—" for p in page_rows])
            pt.add_row("Images",
                *[str(p.num_images) if p else "—" for p in page_rows])
            pt.add_row("Fonts",
                *[str(p.num_fonts) if p else "—" for p in page_rows])
            pt.add_row("Annotations",
                *[str(p.num_annotations) if p else "—" for p in page_rows])

            # Content stream sizes with delta
            cs_vals = [p.content_compressed_bytes if p else -1 for p in page_rows]
            cs_cells = []
            for i, v in enumerate(cs_vals):
                s = fmt_bytes(v)
                if i > 0 and cs_vals[0] > 0 and v >= 0:
                    pct = (v - cs_vals[0]) / cs_vals[0] * 100
                    color = "green" if pct < 0 else "red" if pct > 5 else "white"
                    s += f" [{color}]({pct:+.0f}%)[/{color}]"
                cs_cells.append(s)
            pt.add_row("Content stream (comp)", *cs_cells)

        console.print(pt)

    # ── Per-image comparison ──────────────────────────────────────────────────
    # Match images by (page, order_on_page)
    console.rule("[bold cyan]Per-Image Comparison[/bold cyan]")

    # Build lookup: (page, idx) → image for each analysis
    def build_img_lookup(analysis: PDFAnalysis) -> dict:
        lookup = {}
        page_counters = {}
        for img in sorted(analysis.images, key=lambda x: x.page_order[0] if x.page_order else (999, 999)):
            for page_num, order in img.page_order:
                key = (page_num, order)
                lookup[key] = img
        return lookup

    lookups = [build_img_lookup(a) for a in analyses]
    all_keys = set()
    for lk in lookups:
        all_keys.update(lk.keys())

    for key in sorted(all_keys):
        imgs = [lk.get(key) for lk in lookups]
        if all(i is None for i in imgs):
            continue
        orig_img = imgs[0]
        page_num, order = key

        it = Table(title=f"Page {page_num}, Image {order + 1}", box=box.SIMPLE_HEAD)
        it.add_column("Property", style="dim", width=22)
        for lbl in labels:
            it.add_column(lbl, justify="right")

        def img_metric_row(name, fn, highlight=False):
            vals = [fn(img) if img else "—" for img in imgs]
            cells = [str(v) for v in vals]
            # Highlight changes vs original
            if highlight and imgs[0] is not None:
                new_cells = [cells[0]]
                for i, (v, c) in enumerate(zip(vals[1:], cells[1:]), 1):
                    if v != vals[0] and v != "—":
                        new_cells.append(f"[yellow]{c}[/yellow]")
                    else:
                        new_cells.append(c)
                cells = new_cells
            it.add_row(name, *cells)

        def img_size_row(name, fn):
            vals = [fn(img) if img else -1 for img in imgs]
            orig_v = vals[0]
            cells = []
            for i, v in enumerate(vals):
                s = fmt_bytes(v)
                if i > 0 and orig_v > 0 and v >= 0:
                    pct = (v - orig_v) / orig_v * 100
                    color = "green" if pct < 0 else "red" if pct > 0 else "white"
                    s += f" [{color}]({pct:+.0f}%)[/{color}]"
                cells.append(s)
            it.add_row(name, *cells)

        img_metric_row("Dimensions (px)",
            lambda img: f"{img.width_px}×{img.height_px}", highlight=True)
        img_metric_row("Color space",
            lambda img: img.color_space, highlight=True)
        img_metric_row("Bits/component",
            lambda img: str(img.bits_per_component), highlight=True)
        img_metric_row("Filter",
            lambda img: fmt_filters(img), highlight=True)
        img_metric_row("JPEG quality",
            lambda img: str(img.jpeg_quality) if img.jpeg_quality else "—", highlight=True)
        img_metric_row("DPI",
            lambda img: f"{img.dpi_x:.0f}×{img.dpi_y:.0f}" if img.dpi_x else "—", highlight=True)
        img_size_row("Compressed bytes",  lambda img: img.compressed_bytes)
        img_size_row("Uncompressed bytes", lambda img: img.uncompressed_bytes)
        img_metric_row("Ratio",
            lambda img: f"{img.compression_ratio:.3f}" if img.compression_ratio else "—")
        img_metric_row("Has soft mask",   lambda img: "yes" if img.has_soft_mask else "no")
        img_metric_row("Interpolate",     lambda img: "yes" if img.interpolate else "no")

        console.print(it)

    # ── Per-image delta table ─────────────────────────────────────────────────
    for analysis in rest:
        comp_lookup = build_img_lookup(analysis)
        delta_rows = []
        for key in sorted(all_keys):
            orig_img = lookups[0].get(key)
            comp_img = comp_lookup.get(key)
            if not orig_img or not comp_img:
                continue
            # Skip images with no meaningful changes
            dims_changed = (orig_img.width_px != comp_img.width_px or
                            orig_img.height_px != comp_img.height_px)
            filter_changed = fmt_filters(orig_img) != fmt_filters(comp_img)
            q_changed = (orig_img.jpeg_quality != comp_img.jpeg_quality and
                         (orig_img.jpeg_quality is not None or comp_img.jpeg_quality is not None))
            bytes_changed = orig_img.compressed_bytes != comp_img.compressed_bytes
            smask_issue = comp_img.smask_dimension_mismatch
            if not any([dims_changed, filter_changed, q_changed, bytes_changed, smask_issue]):
                continue
            delta_rows.append((key, orig_img, comp_img))

        if delta_rows:
            dt = Table(
                title=f"Per-Image Delta: [bold]{orig.label}[/bold] → [bold]{analysis.label}[/bold]",
                box=box.SIMPLE_HEAD, show_lines=False
            )
            for col in ["Pg", "Orig dims", "New dims", "Orig filter", "New filter",
                        "Orig Q", "New Q", "Orig bytes", "New bytes", "Δ bytes", "SMask"]:
                dt.add_column(col, justify="right" if col not in ("Orig filter", "New filter") else "left")

            for (page_num, order), orig_img, comp_img in delta_rows:
                dims_orig = f"{orig_img.width_px}×{orig_img.height_px}"
                dims_new = f"{comp_img.width_px}×{comp_img.height_px}"
                if dims_orig == dims_new:
                    dims_new = "="
                else:
                    dims_new = f"[yellow]{dims_new}[/yellow]"

                filt_orig = fmt_filters(orig_img)
                filt_new = fmt_filters(comp_img)
                if filt_orig == filt_new:
                    filt_new = "="
                else:
                    filt_new = f"[yellow]{filt_new}[/yellow]"

                q_orig = f"Q{orig_img.jpeg_quality}" if orig_img.jpeg_quality else "—"
                q_new = f"Q{comp_img.jpeg_quality}" if comp_img.jpeg_quality else "—"
                if q_orig == q_new:
                    q_new = "="
                elif comp_img.jpeg_quality and orig_img.jpeg_quality and \
                        comp_img.jpeg_quality < orig_img.jpeg_quality:
                    q_new = f"[yellow]{q_new}[/yellow]"

                ob = orig_img.compressed_bytes
                nb = comp_img.compressed_bytes
                delta = nb - ob
                if ob > 0:
                    pct = delta / ob * 100
                    sign = "+" if delta > 0 else "-" if delta < 0 else ""
                    color = "green" if delta < 0 else "red" if delta > 0 else "white"
                    delta_str = f"[{color}]{sign}{fmt_bytes(abs(delta))} ({sign}{abs(pct):.0f}%)[/{color}]"
                else:
                    delta_str = "—"

                if not comp_img.has_soft_mask:
                    smask_ok = "—"
                elif comp_img.smask_dimension_mismatch:
                    smask_ok = "[bold red]✗[/bold red]"
                else:
                    smask_ok = "[green]✓[/green]"

                dt.add_row(
                    str(page_num),
                    dims_orig, dims_new,
                    filt_orig, filt_new,
                    q_orig, q_new,
                    fmt_bytes(ob), fmt_bytes(nb),
                    delta_str,
                    smask_ok,
                )
            console.print(dt)

    # ── Font comparison ───────────────────────────────────────────────────────
    console.rule("[bold cyan]Font Comparison[/bold cyan]")
    # Match fonts by name
    all_font_names = []
    seen = set()
    for a in analyses:
        for f in a.fonts:
            clean = f.name.split('+')[-1] if '+' in f.name else f.name
            if clean not in seen:
                seen.add(clean)
                all_font_names.append((clean, f.name))

    if all_font_names:
        ft = Table(box=box.SIMPLE_HEAD, show_lines=False)
        ft.add_column("Font name", width=30)
        for lbl in labels:
            ft.add_column(lbl, justify="right")

        def find_font(analysis, clean_name):
            for f in analysis.fonts:
                fn = f.name.split('+')[-1] if '+' in f.name else f.name
                if fn == clean_name:
                    return f
            return None

        for clean_name, _ in all_font_names:
            fonts = [find_font(a, clean_name) for a in analyses]
            cells = []
            orig_font = fonts[0]
            for i, font in enumerate(fonts):
                if font is None:
                    cells.append("[red]removed[/red]")
                    continue
                parts = []
                if font.embedded:
                    parts.append(f"emb {fmt_bytes(font.stream_bytes)}")
                    if font.subsetted:
                        parts.append("subset")
                else:
                    parts.append("[red]not embedded[/red]")
                cell = " · ".join(parts)
                if i > 0 and orig_font and font.embedded != orig_font.embedded:
                    cell = f"[yellow]{cell}[/yellow]"
                cells.append(cell)
            ft.add_row(clean_name[:30], *cells)
        console.print(ft)

    # ── Key findings ──────────────────────────────────────────────────────────
    console.rule("[bold cyan]Key Findings[/bold cyan]")
    for analysis in rest:
        findings = []
        orig_f = orig.file
        a_f = analysis.file

        size_delta = (analysis.file.size_bytes - orig.file.size_bytes) / orig.file.size_bytes * 100
        findings.append(f"File size change: [bold]{size_delta:+.1f}%[/bold]")

        if a_f.has_object_streams and not orig_f.has_object_streams:
            findings.append("✓ Added object streams (compressed xref/objects)")
        if orig_f.has_xmp and not a_f.has_xmp:
            findings.append("✓ Stripped XMP metadata")

        # Image analysis
        img_downsampled, img_quality_reduced, img_cs_changed, img_filter_changed = [], [], [], []
        for key in sorted(all_keys):
            orig_img = lookups[0].get(key)
            comp_img = build_img_lookup(analysis).get(key)
            if not orig_img or not comp_img:
                continue
            px_orig = orig_img.width_px * orig_img.height_px
            px_comp = comp_img.width_px * comp_img.height_px
            if px_comp < px_orig * 0.95:
                img_downsampled.append(key)
            if orig_img.jpeg_quality and comp_img.jpeg_quality and \
               comp_img.jpeg_quality < orig_img.jpeg_quality - 2:
                img_quality_reduced.append((key, orig_img.jpeg_quality, comp_img.jpeg_quality))
            if orig_img.color_space != comp_img.color_space:
                img_cs_changed.append((key, orig_img.color_space, comp_img.color_space))
            if orig_img.primary_filter != comp_img.primary_filter:
                img_filter_changed.append((key, orig_img.primary_filter, comp_img.primary_filter))

        if img_downsampled:
            findings.append(f"✓ Downsampled {len(img_downsampled)} image(s) (resolution reduced)")
        if img_quality_reduced:
            qs = [f"Q{o}→Q{c}" for _, o, c in img_quality_reduced]
            findings.append(f"✓ Reduced JPEG quality on {len(img_quality_reduced)} image(s): {', '.join(qs[:5])}")
        if img_cs_changed:
            cs_desc = [f"{o}→{c}" for _, o, c in img_cs_changed]
            findings.append(f"✓ Changed color space on {len(img_cs_changed)} image(s): {', '.join(cs_desc[:3])}")
        if img_filter_changed:
            flt_desc = [f"{o}→{c}" for _, o, c in img_filter_changed]
            findings.append(f"✓ Changed image filter on {len(img_filter_changed)} image(s): {', '.join(flt_desc[:3])}")

        # SMask dimension mismatches — deduplicated by object_id, sourced from all images
        smask_mismatches = [img for img in analysis.images if img.smask_dimension_mismatch]
        if smask_mismatches:
            ids = ", ".join(img.object_id for img in smask_mismatches[:5])
            findings.append(
                f"[bold red]✗ SMask dimension mismatch on {len(smask_mismatches)} image(s): "
                f"{ids} — Acrobat will error[/bold red]"
            )
            for img in smask_mismatches:
                findings.append(
                    f"[red]  Object {img.object_id}: SMask {img.smask_width}×{img.smask_height} "
                    f"≠ image {img.width_px}×{img.height_px}[/red]"
                )

        # Other integrity warnings (skip SMask ones already listed above)
        other_warnings = [w for w in analysis.warnings if "SMask" not in w]
        for w in other_warnings:
            findings.append(f"[yellow]⚠ {w}[/yellow]")

        # Font analysis
        fonts_removed_embed = sum(
            1 for fn, _ in all_font_names
            if (f := find_font(orig, fn)) and f.embedded
            and (g := find_font(analysis, fn)) and not g.embedded
        )
        fonts_removed_entirely = sum(
            1 for fn, _ in all_font_names
            if find_font(orig, fn) and not find_font(analysis, fn)
        )
        if fonts_removed_embed:
            findings.append(f"! Removed font embedding for {fonts_removed_embed} font(s)")
        if fonts_removed_entirely:
            findings.append(f"! Removed {fonts_removed_entirely} font(s) entirely")

        panel_content = "\n".join(findings) if findings else "No significant changes detected."
        console.print(Panel(panel_content, title=f"[bold]{analysis.label}[/bold]", expand=False))


# ══════════════════════════════════════════════════════════════════════════════
# Entry point
# ══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Deep PDF analysis and comparison tool")
    parser.add_argument("pdfs", nargs="+", metavar="PDF", help="PDF files to analyze/compare")
    parser.add_argument("--json", metavar="FILE",
                        help="Also write full analysis data to a JSON file")
    args = parser.parse_args()

    paths = [Path(p) for p in args.pdfs]
    for p in paths:
        if not p.exists():
            sys.exit(f"File not found: {p}")

    labels = [p.name for p in paths]

    console.print()
    console.print("[bold]PDF Analyzer[/bold] — loading files...")
    console.print()

    analyses = []
    for path, label in zip(paths, labels):
        analysis = analyze_pdf(path, label)
        analyses.append(analysis)

    console.print()

    if len(analyses) == 1:
        print_single(analyses[0])
    else:
        print_comparison(analyses)

    if args.json:
        out = []
        for a in analyses:
            d = {
                "label": a.label,
                "file": asdict(a.file),
                "pages": [asdict(p) for p in a.pages],
                "images": [asdict(i) for i in a.images],
                "fonts": [asdict(f) for f in a.fonts],
                "warnings": a.warnings,
                "totals": {
                    "image_bytes_compressed": a.total_image_bytes_compressed,
                    "image_bytes_uncompressed": a.total_image_bytes_uncompressed,
                    "font_bytes": a.total_font_bytes,
                    "content_bytes_compressed": a.total_content_bytes_compressed,
                    "content_bytes_uncompressed": a.total_content_bytes_uncompressed,
                }
            }
            out.append(d)
        with open(args.json, 'w') as jf:
            json.dump(out, jf, indent=2)
        console.print(f"\n[dim]JSON written to {args.json}[/dim]")


if __name__ == "__main__":
    main()
