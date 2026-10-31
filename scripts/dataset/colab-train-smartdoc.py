#!/usr/bin/env python3
"""
Self-contained Colab/Kaggle GPU training for the document-corner
YOLOv8n-pose model on the SmartDoc 2015 Ch1 dataset (CC BY 4.0).

Downloads SmartDoc directly on the VM (no upload needed — the dev sandbox
can't push the 80 MB zip through the Jupyter contents API), converts the
quad GT to YOLOv8-pose, trains with the anti-overfit recipe, exports ONNX.

Run headlessly via the official Colab CLI from the dev box:

    colab new  -s docc --gpu T4
    colab exec -s docc -f scripts/dataset/colab-train-smartdoc.py
    colab download -s docc /content/doc-corners.onnx apps/web/public/models/doc-corners.onnx
    colab stop -s docc

SmartDoc corner order in metadata.csv is tl, bl, br, tr; our model channel
order is tl, tr, br, bl (reordered on write). All corners visible (v=2).
Split is by VIDEO so val shares no scene with train.
"""

import os
import sys
import shutil
import tarfile
import subprocess

URL = "https://github.com/jchazalon/smartdoc15-ch1-dataset/releases/download/v2.0.0/frames.tar.gz"
SD = "/content/sd"
DS = "/content/ds"
OUT = "/content/doc-corners.onnx"
PER_VIDEO = 12
VAL_EVERY = 8
W = 1920.0
H = 1080.0


def sh(*a):
    subprocess.run(list(a), check=True)


def main():
    sh(sys.executable, "-m", "pip", "install", "-q", "ultralytics", "onnx", "onnxsim", "pandas")

    os.makedirs(SD, exist_ok=True)
    if not os.path.exists(f"{SD}/metadata.csv.gz"):
        print("downloading SmartDoc frames (972 MB)...", flush=True)
        sh("wget", "-q", URL, "-O", "/content/frames.tar.gz")
        with tarfile.open("/content/frames.tar.gz") as t:
            t.extractall(SD)
    print("extracted", flush=True)

    import pandas as pd
    df = pd.read_csv(f"{SD}/metadata.csv.gz")
    df["video"] = df["bg_name"] + "/" + df["model_name"]
    videos = sorted(df["video"].unique())

    shutil.rmtree(DS, ignore_errors=True)
    for s in ("train", "val"):
        os.makedirs(f"{DS}/images/{s}", exist_ok=True)
        os.makedirs(f"{DS}/labels/{s}", exist_ok=True)

    def clamp(v):
        return min(1.0, max(0.0, v))

    def label(r):
        # our keypoint order: tl, tr, br, bl
        xs = [clamp(r.tl_x / W), clamp(r.tr_x / W), clamp(r.br_x / W), clamp(r.bl_x / W)]
        ys = [clamp(r.tl_y / H), clamp(r.tr_y / H), clamp(r.br_y / H), clamp(r.bl_y / H)]
        cx = (min(xs) + max(xs)) / 2
        cy = (min(ys) + max(ys)) / 2
        w = max(1e-4, max(xs) - min(xs))
        h = max(1e-4, max(ys) - min(ys))
        kp = " ".join(f"{xs[i]:.6f} {ys[i]:.6f} 2" for i in range(4))
        return f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f} {kp}"

    nt = nv = 0
    for vi, v in enumerate(videos):
        rows = df[df.video == v].reset_index(drop=True)
        split = "val" if vi % VAL_EVERY == VAL_EVERY - 1 else "train"
        step = max(1, len(rows) // PER_VIDEO)
        for i in range(0, len(rows), step):
            r = rows.iloc[i]
            src = f"{SD}/{r.image_path}"
            if not os.path.exists(src):
                continue
            flat = r.image_path.replace("/", "_").rsplit(".", 1)[0]
            shutil.copyfile(src, f"{DS}/images/{split}/{flat}.jpg")
            with open(f"{DS}/labels/{split}/{flat}.txt", "w") as f:
                f.write(label(r) + "\n")
            if split == "val":
                nv += 1
            else:
                nt += 1
    print(f"dataset: train={nt} val={nv} from {len(videos)} videos", flush=True)

    with open(f"{DS}/data.yaml", "w") as f:
        f.write(
            f"path: {DS}\ntrain: images/train\nval: images/val\n"
            "kpt_shape: [4, 3]\nflip_idx: [1, 0, 3, 2]\nnames:\n  0: document\n"
        )

    from ultralytics import YOLO
    model = YOLO("yolov8n-pose.pt")
    model.train(
        data=f"{DS}/data.yaml",
        epochs=60, imgsz=640, batch=16, patience=15,
        optimizer="AdamW", lr0=0.001, cos_lr=True,
        freeze=10,
        hsv_s=0.9, hsv_v=0.5, hsv_h=0.05,
        degrees=10, translate=0.1, scale=0.5, fliplr=0.5,
        kobj=2.0, pose=12.0,
        project="/content/runs", name="doc", exist_ok=True,
    )
    best = YOLO("/content/runs/doc/weights/best.pt")
    best.export(format="onnx", imgsz=640, simplify=True, opset=12, dynamic=False)
    shutil.copyfile("/content/runs/doc/weights/best.onnx", OUT)
    print("DONE ->", OUT, flush=True)


if __name__ == "__main__":
    main()
