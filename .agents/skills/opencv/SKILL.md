---
name: opencv
description: Best practices for computer vision in Python with OpenCV (cv2), image decoding from bytes/base64, color space conversions (BGR/RGB/LAB), contours, and landmark geometry.
---

# OpenCV (cv2) Best Practices

## Core Principles
1. **Image Decoding**: Decode raw bytes with np.frombuffer and cv2.imdecode(buf, cv2.IMREAD_COLOR).
2. **Color Spaces**: Remember OpenCV reads in BGR by default. Convert to RGB (cv2.COLOR_BGR2RGB) before sending to MediaPipe or displaying. Use LAB for skin luminance/color metrics.
3. **Array Slicing & Clipping**: Always ensure coordinates are within image boundaries: np.clip(coords, 0, max_val).
4. **Contours & Polygons**: Use cv2.convexHull and cv2.fillConvexPoly for precise facial masks.
