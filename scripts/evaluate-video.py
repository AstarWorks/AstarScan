#!/usr/bin/env python3
"""
AstarScan accuracy evaluation: process a video file frame-by-frame
through DocAligner ONNX and report detection statistics.

Usage:
  uv run --with onnxruntime,opencv-python,numpy scripts/evaluate-video.py <video.mp4> [--interval 0.5]

Arguments:
  video.mp4         Input video file
  --interval N      Seconds between sampled frames (default: 0.5)
  --model PATH      DocAligner ONNX model (default: apps/web/public/models/docaligner-fastvit-t8.onnx)
  --output-dir DIR  Save extracted pages as JPEG (default: /tmp/astarscan-eval)
  --threshold FLOAT Heatmap threshold (default: 0.3)

Output:
  - Detection rate (% of frames where a document was found)
  - Per-frame: detected (Y/N), confidence proxy (max heatmap activation), sharpness
  - Extracted page JPEGs saved to --output-dir
"""

import argparse
import os
import sys
import time

import cv2
import numpy as np
import onnxruntime as ort


def parse_args():
    p = argparse.ArgumentParser(description="Evaluate DocAligner on video frames")
    p.add_argument("video", help="Path to input video file")
    p.add_argument("--interval", type=float, default=0.5, help="Frame sample interval in seconds")
    p.add_argument("--model", default="apps/web/public/models/docaligner-fastvit-t8.onnx",
                   help="Path to DocAligner ONNX model")
    p.add_argument("--output-dir", default="/tmp/astarscan-eval", help="Output directory for extracted pages")
    p.add_argument("--threshold", type=float, default=0.3, help="Heatmap threshold")
    return p.parse_args()


def weighted_centroid(heatmap: np.ndarray, threshold: float):
    """Find weighted centroid of pixels above threshold in a 2D heatmap."""
    mask = heatmap > threshold
    if not mask.any():
        return None
    ys, xs = np.where(mask)
    weights = heatmap[mask]
    cx = np.average(xs, weights=weights)
    cy = np.average(ys, weights=weights)
    return (cx, cy)


def detect_corners(session: ort.InferenceSession, frame: np.ndarray, threshold: float):
    """Run DocAligner on a single frame. Returns 4 corner points or None."""
    h, w = frame.shape[:2]

    # Preprocess: resize to 256x256, NCHW float32, /255
    resized = cv2.resize(frame, (256, 256))
    tensor = resized.astype(np.float32).transpose(2, 0, 1)[np.newaxis] / 255.0

    # Inference
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    result = session.run([output_name], {input_name: tensor})[0]

    # result shape: (1, 4, H, W)
    corners = []
    for c in range(4):
        heatmap = result[0, c]
        point = weighted_centroid(heatmap, threshold)
        if point is None:
            return None
        # Scale from heatmap coordinates to original frame
        hx, hy = heatmap.shape[1], heatmap.shape[0]
        corners.append((point[0] / hx * w, point[1] / hy * h))

    return corners


def compute_sharpness(gray: np.ndarray) -> float:
    """Laplacian variance (same as blur-detection.ts)."""
    lap = cv2.Laplacian(gray, cv2.CV_64F)
    return lap.var()


def warp_perspective(frame: np.ndarray, corners, out_w=1200, out_h=1600):
    """Perspective warp using detected corners."""
    src = np.float32(corners)
    dst = np.float32([[0, 0], [out_w, 0], [out_w, out_h], [0, out_h]])
    M = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(frame, M, (out_w, out_h))


def main():
    args = parse_args()

    if not os.path.exists(args.model):
        print(f"ERROR: Model file not found: {args.model}", file=sys.stderr)
        print("Run: ./scripts/download-ocr-models.sh first (for DocAligner, the model should already be in public/models/)")
        sys.exit(1)

    os.makedirs(args.output_dir, exist_ok=True)

    print(f"Loading model: {args.model}")
    session = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    print(f"Model loaded. Input: {session.get_inputs()[0].shape}, Output: {session.get_outputs()[0].shape}")

    print(f"Opening video: {args.video}")
    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"ERROR: Cannot open video: {args.video}", file=sys.stderr)
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if fps > 0 else 0
    frame_interval = int(fps * args.interval) if fps > 0 else 15

    print(f"Video: {total_frames} frames, {fps:.1f} FPS, {duration:.1f}s")
    print(f"Sampling every {args.interval}s ({frame_interval} frames)")
    print(f"Heatmap threshold: {args.threshold}")
    print(f"Output: {args.output_dir}")
    print()

    results = []
    frame_idx = 0
    page_num = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % frame_interval != 0:
            frame_idx += 1
            continue

        t0 = time.time()
        corners = detect_corners(session, frame, args.threshold)
        detect_ms = (time.time() - t0) * 1000

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        # Downscale for sharpness (match blur-detection.ts at 320px)
        gray_small = cv2.resize(gray, (320, int(320 * gray.shape[0] / gray.shape[1])))
        sharpness = compute_sharpness(gray_small)

        detected = corners is not None
        timestamp = frame_idx / fps if fps > 0 else frame_idx

        result = {
            "frame": frame_idx,
            "time": f"{timestamp:.1f}s",
            "detected": detected,
            "sharpness": round(sharpness, 1),
            "detect_ms": round(detect_ms, 1),
        }

        if detected and corners:
            page_num += 1
            warped = warp_perspective(frame, corners)
            out_path = os.path.join(args.output_dir, f"page-{page_num:03d}.jpg")
            cv2.imwrite(out_path, warped, [cv2.IMWRITE_JPEG_QUALITY, 85])
            result["page"] = page_num
            result["output"] = out_path

        results.append(result)

        status = "✓" if detected else "✗"
        page_info = f" → page {page_num}" if detected else ""
        print(f"  [{status}] frame {frame_idx:5d} ({timestamp:6.1f}s) | "
              f"sharpness={sharpness:7.1f} | detect={detect_ms:5.1f}ms{page_info}")

        frame_idx += 1

    cap.release()

    # Summary
    total = len(results)
    detected_count = sum(1 for r in results if r["detected"])
    rate = (detected_count / total * 100) if total > 0 else 0
    avg_ms = np.mean([r["detect_ms"] for r in results]) if results else 0
    avg_sharpness = np.mean([r["sharpness"] for r in results]) if results else 0

    print()
    print("=" * 60)
    print(f"SUMMARY")
    print(f"  Frames sampled:    {total}")
    print(f"  Documents found:   {detected_count}")
    print(f"  Detection rate:    {rate:.1f}%")
    print(f"  Pages extracted:   {page_num}")
    print(f"  Avg detect time:   {avg_ms:.1f}ms")
    print(f"  Avg sharpness:     {avg_sharpness:.1f}")
    print(f"  Output directory:  {args.output_dir}")
    print("=" * 60)


if __name__ == "__main__":
    main()
