#!/usr/bin/env python3
"""
Optional local IDP worker.

It provides two fallbacks:
1. pypdf text visitor anchor extraction.
2. OpenCV horizontal line detection plus Tesseract OCR keyword context.

The Node service treats this worker as best-effort. Missing optional Python
packages are reported in diagnostics instead of failing the signing flow.
"""

import json
import os
import re
import sys
from pathlib import Path

ANCHOR_RE = re.compile(r"\{\{([A-Za-z0-9_:-]+)\}\}")
SIGNATURE_WORDS = re.compile(r"\b(sign|signature|signed by|sign here|authorized signatory)\b", re.I)
DATE_WORDS = re.compile(r"\b(date|dated)\b", re.I)
INITIAL_WORDS = re.compile(r"\b(initial|initials)\b", re.I)
NAME_WORDS = re.compile(r"\b(print name|printed name|name)\b", re.I)


def infer_field_type(text):
    if DATE_WORDS.search(text or ""):
        return "date"
    if INITIAL_WORDS.search(text or ""):
        return "initials"
    if NAME_WORDS.search(text or ""):
        return "text"
    return "signature"


def page_metrics():
    try:
        return json.loads(os.environ.get("IDP_PAGE_METRICS", "[]"))
    except Exception:
        return []


def metric_for(metrics, page_index):
    if page_index < len(metrics):
        return metrics[page_index]
    return {"page": page_index + 1, "width": 612, "height": 792}


def extract_anchors_with_pypdf(pdf_path, metrics, diagnostics):
    fields = []
    try:
        from pypdf import PdfReader
    except Exception as exc:
        diagnostics["pypdf"] = {"available": False, "error": str(exc)}
        return fields

    diagnostics["pypdf"] = {"available": True, "fields": 0}
    reader = PdfReader(pdf_path)

    for page_index, page in enumerate(reader.pages):
        metric = metric_for(metrics, page_index)

        def visitor(text, user_matrix, tm_matrix, font_dict, font_size):
            if not text or "{{" not in text:
                return
            x0 = float(user_matrix[4] or 0)
            y0 = float(user_matrix[5] or 0)
            char_w = max(float(font_size or 10) * 0.5, 4)
            for match in ANCHOR_RE.finditer(text):
                label = match.group(1)
                fields.append({
                    "source": "anchor",
                    "detector": "pypdf-text-layer",
                    "anchor": match.group(0),
                    "name": label,
                    "type": infer_field_type(label),
                    "page": page_index + 1,
                    "x": x0 + match.start() * char_w,
                    "y": max(0, y0 - 8),
                    "width": max(110, min(260, len(match.group(0)) * char_w)),
                    "height": 32,
                    "confidence": 1.0,
                    "context": label,
                    "pageWidth": metric.get("width"),
                    "pageHeight": metric.get("height"),
                })

        try:
            page.extract_text(visitor_text=visitor)
        except Exception as exc:
            diagnostics["pypdf"].setdefault("pageErrors", []).append({
                "page": page_index + 1,
                "error": str(exc),
            })

    diagnostics["pypdf"]["fields"] = len(fields)
    return fields


def detect_lines_with_opencv(pdf_path, metrics, diagnostics):
    fields = []
    try:
        import cv2
        import numpy as np
        import pytesseract
        from pdf2image import convert_from_path
    except Exception as exc:
        diagnostics["opencvTesseract"] = {"available": False, "error": str(exc)}
        return fields

    diagnostics["opencvTesseract"] = {"available": True, "fields": 0}
    try:
        images = convert_from_path(pdf_path, dpi=160)
    except Exception as exc:
        diagnostics["opencvTesseract"]["error"] = str(exc)
        return fields

    for page_index, pil_image in enumerate(images):
        metric = metric_for(metrics, page_index)
        image = cv2.cvtColor(np.array(pil_image), cv2.COLOR_RGB2BGR)
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 50, 150, apertureSize=3)
        lines = cv2.HoughLinesP(edges, 1, np.pi / 180, 80, minLineLength=90, maxLineGap=8)

        ocr = pytesseract.image_to_data(pil_image, output_type=pytesseract.Output.DICT)
        words = []
        for i, text in enumerate(ocr.get("text", [])):
            cleaned = (text or "").strip()
            if not cleaned:
                continue
            words.append({
                "text": cleaned,
                "x": float(ocr["left"][i]),
                "y": float(ocr["top"][i]),
                "w": float(ocr["width"][i]),
                "h": float(ocr["height"][i]),
                "cx": float(ocr["left"][i]) + float(ocr["width"][i]) / 2,
                "cy": float(ocr["top"][i]) + float(ocr["height"][i]) / 2,
            })

        if lines is None:
            continue

        img_h, img_w = image.shape[:2]
        scale_x = float(metric.get("width", 612)) / img_w
        scale_y = float(metric.get("height", 792)) / img_h

        for line in lines:
            x1, y1, x2, y2 = [float(v) for v in line[0]]
            if abs(y1 - y2) > 3 or x2 <= x1:
                continue
            nearby = [
                word for word in words
                if abs(word["cy"] - y1) < 45 and word["x"] < x1 + 12
            ]
            context = " ".join(word["text"] for word in nearby[-8:])
            if not (SIGNATURE_WORDS.search(context) or DATE_WORDS.search(context) or INITIAL_WORDS.search(context) or NAME_WORDS.search(context)):
                continue

            field_type = infer_field_type(context)
            width = max(80, (x2 - x1) * scale_x)
            height = 32 if field_type != "date" else 24
            fields.append({
                "source": "opencv-ocr",
                "detector": "opencv-houghlinesp-tesseract",
                "type": field_type,
                "page": page_index + 1,
                "x": x1 * scale_x,
                "y": float(metric.get("height", 792)) - (y1 * scale_y) - height,
                "width": width,
                "height": height,
                "confidence": 0.65,
                "context": context,
            })

    diagnostics["opencvTesseract"]["fields"] = len(fields)
    return fields


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"fields": [], "diagnostics": {"error": "missing pdf path"}}))
        return

    pdf_path = Path(sys.argv[1])
    metrics = page_metrics()
    diagnostics = {"worker": "detect_fields.py"}
    fields = []

    if not pdf_path.exists():
        print(json.dumps({"fields": [], "diagnostics": {"error": "pdf path not found"}}))
        return

    fields.extend(extract_anchors_with_pypdf(str(pdf_path), metrics, diagnostics))
    fields.extend(detect_lines_with_opencv(str(pdf_path), metrics, diagnostics))

    print(json.dumps({"fields": fields, "diagnostics": diagnostics}))


if __name__ == "__main__":
    main()
