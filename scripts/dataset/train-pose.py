#!/usr/bin/env python3
"""
Train the document-corner YOLOv8n-pose model on a Colab/Kaggle GPU VM and
export ONNX. Driven headlessly from the dev box via the official Colab CLI:

    colab new -s docc --gpu T4
    colab upload -s docc scripts/dataset/external/doc-corners-data.zip /content/data.zip
    colab exec   -s docc -f scripts/dataset/train-pose.py
    colab download -s docc /content/doc-corners.onnx apps/web/public/models/doc-corners.onnx
    colab stop   -s docc

The zip must contain a YOLOv8-pose dataset dir holding `data.yaml`
(images/{train,val}, labels/{train,val}). Produced by
import-smartdoc.mjs (SmartDoc v1) or build-dataset.mjs (our labeled frames).

Anti-overfit recipe (small/low-diversity data): freeze the COCO-pose
backbone, early-stop on val, heavy HSV jitter for desk-colour/lighting
robustness. Keep `best.pt`. See docs/training-doc-corners.md.
"""

import os
import sys
import glob
import shutil
import zipfile
import subprocess

ZIP = "/content/data.zip"
WORK = "/content/ds"
OUT = "/content/doc-corners.onnx"


def sh(*args):
    subprocess.run(list(args), check=True)


def main():
    sh(sys.executable, "-m", "pip", "install", "-q", "ultralytics", "onnx", "onnxsim", "pyyaml")

    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK)
    with zipfile.ZipFile(ZIP) as z:
        z.extractall(WORK)

    # Locate the dataset root (dir containing data.yaml).
    yamls = glob.glob(f"{WORK}/**/data.yaml", recursive=True)
    if not yamls:
        raise SystemExit("no data.yaml found in zip")
    root = os.path.dirname(yamls[0])

    # Point data.yaml's `path` at the absolute extracted dir.
    import yaml
    with open(f"{root}/data.yaml") as f:
        d = yaml.safe_load(f)
    d["path"] = root
    with open(f"{root}/data.yaml", "w") as f:
        yaml.safe_dump(d, f)
    print("dataset:", root, d)

    from ultralytics import YOLO
    model = YOLO("yolov8n-pose.pt")
    model.train(
        data=f"{root}/data.yaml",
        epochs=30,
        imgsz=512,
        batch=32,
        patience=8,
        optimizer="AdamW",
        lr0=0.001,
        cos_lr=True,
        freeze=10,            # freeze COCO-pose backbone — adapt only the head
        hsv_s=0.9, hsv_v=0.5, hsv_h=0.05,  # colour/lighting robustness
        degrees=10, translate=0.1, scale=0.5, fliplr=0.5,
        kobj=2.0, pose=12.0,
        project="/content/runs", name="doc", exist_ok=True,
    )

    best = YOLO("/content/runs/doc/weights/best.pt")
    best.export(format="onnx", imgsz=640, simplify=True, opset=12, dynamic=False)
    shutil.copy("/content/runs/doc/weights/best.onnx", OUT)
    print("DONE ->", OUT)


if __name__ == "__main__":
    main()
