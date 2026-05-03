#!/usr/bin/env python3
"""
YOLO/CNN document field detector.

This worker is intentionally optional. If the model or Python packages are not
installed, it returns diagnostics and no fields instead of failing the signing
preparation flow.

Output geometry is normalized to 0-100 percentages in top-left image space:
  xPercent, yPercent, widthPercent, heightPercent
"""

import json
import os
import sys
from pathlib import Path


DEFAULT_LABEL_MAP = {
    "signature": "signature",
    "signature_line": "signature",
    "sign_here": "signature",
    "date": "date",
    "date_label": "date",
    "dated": "date",
    "checkbox": "checkbox",
    "check_box": "checkbox",
    "tick_box": "checkbox",
}


def env_float(name, fallback):
    try:
        return float(os.environ.get(name, fallback))
    except Exception:
        return fallback


def env_int(name, fallback):
    try:
        return int(os.environ.get(name, fallback))
    except Exception:
        return fallback


def label_map():
    raw = os.environ.get("IDP_VISION_LABEL_MAP") or os.environ.get("CV_LABEL_MAP")
    if not raw:
        return DEFAULT_LABEL_MAP
    try:
        parsed = json.loads(raw)
        return {**DEFAULT_LABEL_MAP, **{str(k).lower(): str(v) for k, v in parsed.items()}}
    except Exception:
        return DEFAULT_LABEL_MAP


def normalize_label(label, mapping):
    cleaned = str(label or "").strip().lower().replace("-", "_").replace(" ", "_")
    return mapping.get(cleaned, cleaned)


def box_iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    left = max(ax1, bx1)
    top = max(ay1, by1)
    right = min(ax2, bx2)
    bottom = min(ay2, by2)
    inter = max(0.0, right - left) * max(0.0, bottom - top)
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def nms(detections, threshold):
    kept = []
    by_page_type = {}
    for det in detections:
        by_page_type.setdefault((det["page"], det["type"]), []).append(det)

    for group in by_page_type.values():
        pending = sorted(group, key=lambda item: item["confidence"], reverse=True)
        while pending:
            current = pending.pop(0)
            kept.append(current)
            pending = [
                candidate for candidate in pending
                if box_iou(current["pixelBox"], candidate["pixelBox"]) <= threshold
            ]

    return sorted(kept, key=lambda item: (item["page"], item["yPercent"], item["xPercent"]))


def percent_box(x1, y1, x2, y2, image_width, image_height):
    x1 = max(0.0, min(float(x1), float(image_width)))
    y1 = max(0.0, min(float(y1), float(image_height)))
    x2 = max(0.0, min(float(x2), float(image_width)))
    y2 = max(0.0, min(float(y2), float(image_height)))
    left = min(x1, x2)
    top = min(y1, y2)
    right = max(x1, x2)
    bottom = max(y1, y2)
    width = max(0.0, right - left)
    height = max(0.0, bottom - top)
    return {
        "xPercent": round((left / image_width) * 100.0, 6),
        "yPercent": round((top / image_height) * 100.0, 6),
        "widthPercent": round((width / image_width) * 100.0, 6),
        "heightPercent": round((height / image_height) * 100.0, 6),
    }


def rasterize_pdf(pdf_path, dpi):
    from pdf2image import convert_from_path

    return convert_from_path(pdf_path, dpi=dpi)


def load_yolo_model(model_path):
    from ultralytics import YOLO

    return YOLO(model_path)


def predict_page(model, pil_image, confidence):
    # Ultralytics accepts PIL images directly and performs its own preprocessing.
    return model.predict(source=pil_image, conf=confidence, verbose=False)


def detections_from_result(result, page_number, image_width, image_height, dpi, mapping):
    names = getattr(result, "names", None) or {}
    boxes = getattr(result, "boxes", None)
    if boxes is None:
        return []

    xyxy = boxes.xyxy.cpu().numpy().tolist() if hasattr(boxes.xyxy, "cpu") else boxes.xyxy.tolist()
    confs = boxes.conf.cpu().numpy().tolist() if hasattr(boxes.conf, "cpu") else boxes.conf.tolist()
    classes = boxes.cls.cpu().numpy().tolist() if hasattr(boxes.cls, "cpu") else boxes.cls.tolist()

    fields = []
    for box, score, cls_id in zip(xyxy, confs, classes):
        raw_label = names.get(int(cls_id), str(int(cls_id))) if isinstance(names, dict) else str(int(cls_id))
        field_type = normalize_label(raw_label, mapping)
        if field_type not in {"signature", "date", "checkbox"}:
            continue

        x1, y1, x2, y2 = [float(v) for v in box]
        normalized = percent_box(x1, y1, x2, y2, image_width, image_height)
        fields.append({
            "source": "yolo-cv",
            "detector": "yolo-document-layout",
            "type": field_type,
            "rawType": raw_label,
            "page": page_number,
            "confidence": round(float(score), 6),
            "coordinateOrigin": "percent-top-left",
            "pixelBox": [round(x1, 3), round(y1, 3), round(x2, 3), round(y2, 3)],
            "imageWidth": image_width,
            "imageHeight": image_height,
            "dpi": dpi,
            **normalized,
        })
    return fields


def run(pdf_path):
    dpi = env_int("IDP_VISION_DPI", 300)
    confidence = env_float("IDP_VISION_CONFIDENCE", 0.25)
    nms_iou = env_float("IDP_VISION_NMS_IOU", 0.45)
    max_pages = env_int("IDP_VISION_MAX_PAGES", 0)
    model_path = (
        os.environ.get("IDP_YOLO_MODEL_PATH")
        or os.environ.get("IDP_VISION_MODEL_PATH")
        or os.environ.get("CV_YOLO_MODEL_PATH")
    )
    diagnostics = {
        "worker": "yolo_field_detector.py",
        "enabled": bool(model_path),
        "dpi": dpi,
        "confidenceThreshold": confidence,
        "nmsIouThreshold": nms_iou,
        "modelPath": model_path or "",
        "fieldsBeforeNms": 0,
        "fields": 0,
    }

    if not model_path:
        diagnostics["error"] = "Set IDP_YOLO_MODEL_PATH or IDP_VISION_MODEL_PATH to enable YOLO field detection."
        return {"fields": [], "diagnostics": diagnostics}

    if not Path(model_path).exists():
        diagnostics["error"] = "Configured YOLO model file was not found."
        return {"fields": [], "diagnostics": diagnostics}

    try:
        pages = rasterize_pdf(pdf_path, dpi)
    except Exception as exc:
        diagnostics["error"] = f"PDF rasterization failed: {exc}"
        return {"fields": [], "diagnostics": diagnostics}

    try:
        model = load_yolo_model(model_path)
    except Exception as exc:
        diagnostics["error"] = f"YOLO model load failed: {exc}"
        return {"fields": [], "diagnostics": diagnostics}

    mapping = label_map()
    fields = []
    page_limit = max_pages if max_pages > 0 else len(pages)

    for page_index, pil_image in enumerate(pages[:page_limit]):
        image_width, image_height = pil_image.size
        try:
            results = predict_page(model, pil_image, confidence)
            for result in results:
                fields.extend(detections_from_result(
                    result,
                    page_index + 1,
                    image_width,
                    image_height,
                    dpi,
                    mapping,
                ))
        except Exception as exc:
            diagnostics.setdefault("pageErrors", []).append({
                "page": page_index + 1,
                "error": str(exc),
            })

    diagnostics["pagesRasterized"] = len(pages)
    diagnostics["pagesProcessed"] = min(page_limit, len(pages))
    diagnostics["fieldsBeforeNms"] = len(fields)
    fields = nms(fields, nms_iou)
    diagnostics["fields"] = len(fields)
    return {"fields": fields, "diagnostics": diagnostics}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"fields": [], "diagnostics": {"error": "missing pdf path"}}))
        return

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(json.dumps({"fields": [], "diagnostics": {"error": "pdf path not found"}}))
        return

    print(json.dumps(run(str(pdf_path))))


if __name__ == "__main__":
    main()
