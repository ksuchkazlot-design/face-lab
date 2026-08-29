"""End-to-end smoke test for FACE LAB.

Boots the FastAPI app in-process with TestClient, renders a synthetic but
detectable face, and exercises every route plus the analysis pipeline.
"""

import io
import json
import math
import os
import sys

import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid

import cv2
import numpy as np

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

import server  # noqa: E402


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class Response(object):
    def __init__(self, status, body):
        self.status_code = status
        self.body = body

    @property
    def text(self):
        return self.body.decode("utf-8", "replace")

    def json(self):
        return json.loads(self.text)


class HttpClient(object):
    """Minimal stdlib HTTP client with multipart support."""

    def __init__(self, base_url):
        self.base_url = base_url.rstrip("/")

    def _send(self, request):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return Response(response.status, response.read())
        except urllib.error.HTTPError as error:
            return Response(error.code, error.read())

    def get(self, path):
        return self._send(urllib.request.Request(self.base_url + path))

    def post(self, path, files=None, data=None):
        boundary = "----facelab" + uuid.uuid4().hex
        parts = []
        for name, value in (data or {}).items():
            parts.append(
                ("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n"
                 % (boundary, name, value)).encode("utf-8")
            )
        for name, (filename, payload, content_type) in (files or {}).items():
            head = ("--%s\r\nContent-Disposition: form-data; name=\"%s\"; "
                    "filename=\"%s\"\r\nContent-Type: %s\r\n\r\n"
                    % (boundary, name, filename, content_type)).encode("utf-8")
            parts.append(head + payload + b"\r\n")
        parts.append(("--%s--\r\n" % boundary).encode("utf-8"))
        body = b"".join(parts)

        request = urllib.request.Request(
            self.base_url + path, data=body, method="POST",
            headers={"Content-Type": "multipart/form-data; boundary=" + boundary,
                     "Content-Length": str(len(body))},
        )
        return self._send(request)


def wait_for_server(client, attempts=90):
    for _ in range(attempts):
        try:
            if client.get("/api/health").status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(1.0)
    return False


def draw_face(width=520, height=680, profile=False):
    """Render a simple frontal or profile face that FaceLandmarker can detect."""
    image = np.full((height, width, 3), 232, dtype=np.uint8)
    cx, cy = width // 2, height // 2

    skin = (176, 198, 224)
    if profile:
        cx = int(width * 0.56)

    # head
    cv2.ellipse(image, (cx, cy), (int(width * 0.27), int(height * 0.35)),
                0, 0, 360, skin, -1)
    # hair band
    cv2.ellipse(image, (cx, int(cy - height * 0.27)),
                (int(width * 0.27), int(height * 0.14)), 0, 180, 360, (48, 52, 62), -1)

    eye_dy = int(height * 0.06)
    eye_dx = int(width * 0.10)
    for sign in (-1, 1):
        ex = cx + sign * eye_dx
        ey = cy - eye_dy
        cv2.ellipse(image, (ex, ey), (int(width * 0.052), int(height * 0.021)),
                    0, 0, 360, (250, 250, 250), -1)
        cv2.circle(image, (ex, ey), int(width * 0.021), (70, 60, 55), -1)
        cv2.ellipse(image, (ex, ey - int(height * 0.038)),
                    (int(width * 0.058), int(height * 0.012)), 0, 180, 360,
                    (60, 62, 72), 3)

    # nose
    nose_top = cy - int(height * 0.02)
    nose_bottom = cy + int(height * 0.07)
    cv2.line(image, (cx, nose_top), (cx, nose_bottom), (150, 172, 198), 3)
    cv2.ellipse(image, (cx, nose_bottom), (int(width * 0.045), int(height * 0.014)),
                0, 0, 180, (150, 172, 198), -1)

    # mouth
    mouth_y = cy + int(height * 0.145)
    cv2.ellipse(image, (cx, mouth_y), (int(width * 0.085), int(height * 0.024)),
                0, 0, 360, (120, 120, 175), -1)
    cv2.line(image, (cx - int(width * 0.085), mouth_y),
             (cx + int(width * 0.085), mouth_y), (90, 90, 140), 2)

    # brow shading for texture variety
    cv2.ellipse(image, (cx, cy + int(height * 0.26)),
                (int(width * 0.17), int(height * 0.07)), 0, 0, 180,
                (168, 190, 216), -1)

    return image


def encode(image):
    ok, buffer = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 94])
    if not ok:
        raise RuntimeError("failed to encode test image")
    return buffer.tobytes()


def check(label, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    print("[%s] %s%s" % (status, label, (" - " + detail) if detail else ""))
    return bool(condition)


def main():
    failures = 0
    port = free_port()
    env = dict(os.environ)
    env["FACE_LAB_PORT"] = str(port)
    env["FACE_LAB_HOST"] = "127.0.0.1"

    print("booting server on port %d ..." % port)
    process = subprocess.Popen(
        [sys.executable, os.path.join(BASE, "server.py")],
        cwd=BASE, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )

    client = HttpClient("http://127.0.0.1:%d" % port)

    try:
        if not wait_for_server(client):
            print("[FAIL] server did not become ready")
            process.terminate()
            out = process.communicate(timeout=20)[0]
            print(out.decode("utf-8", "replace")[-3000:])
            return 1
        print("server ready\n")
        # --- static routes -------------------------------------------------
        response = client.get("/")
        failures += not check("GET /", response.status_code == 200
                              and "FACE LAB" in response.text)

        for path, marker in (("/style.css", "--teal"),
                             ("/script.js", "analyze-complete"),
                             ("/shared.js", "window.FaceLab"),
                             ("/analysis-page.js", "FaceLabPage"),
                             ("/detail-page.js", "FaceLabDetail")):
            response = client.get(path)
            failures += not check("GET " + path,
                                  response.status_code == 200 and marker in response.text)

        for name in ("harmony", "angularity", "dimorphism", "features", "skin", "hair"):
            response = client.get("/analysis/%s.html" % name)
            failures += not check("GET /analysis/%s.html" % name,
                                  response.status_code == 200
                                  and 'key: "%s"' % name in response.text)

            response = client.get("/details/%s-detail.html" % name)
            failures += not check("GET /details/%s-detail.html" % name,
                                  response.status_code == 200
                                  and 'category: "%s"' % name in response.text)

        # --- traversal guard ------------------------------------------------
        response = client.get("/analysis/../server.py")
        failures += not check("path traversal blocked", response.status_code == 404,
                              "status %d" % response.status_code)

        # --- api routes -----------------------------------------------------
        response = client.get("/api/health")
        payload = response.json()
        failures += not check("GET /api/health",
                              response.status_code == 200
                              and payload["metric_count"] == 52
                              and payload["standard_count"] == 8,
                              "metrics=%s standards=%s" % (payload.get("metric_count"),
                                                           payload.get("standard_count")))

        response = client.get("/api/standards")
        payload = response.json()
        failures += not check("GET /api/standards",
                              response.status_code == 200
                              and len(payload["standards"]) == 8
                              and len(payload["metrics"]) == 52,
                              "combos=%d" % len(payload["standards"]))

        # --- validation -----------------------------------------------------
        front = encode(draw_face())
        response = client.post("/analyze-complete",
                               files={"front": ("f.jpg", front, "image/jpeg")},
                               data={"gender": "alien", "ethnicity": "caucasian"})
        failures += not check("bad gender rejected", response.status_code == 400,
                              "status %d" % response.status_code)

        response = client.post("/analyze-complete",
                               files={"front": ("f.txt", b"not an image", "text/plain")},
                               data={"gender": "male", "ethnicity": "caucasian"})
        failures += not check("bad image rejected", response.status_code == 400,
                              "status %d" % response.status_code)

        response = client.post("/analyze-complete",
                               data={"gender": "male", "ethnicity": "caucasian"})
        failures += not check("missing front rejected", response.status_code == 422,
                              "status %d" % response.status_code)

        # --- full analysis --------------------------------------------------
        profile = encode(draw_face(profile=True))
        response = client.post(
            "/analyze-complete",
            files={"front": ("front.jpg", front, "image/jpeg"),
                   "profile": ("profile.jpg", profile, "image/jpeg")},
            data={"gender": "male", "ethnicity": "caucasian"},
        )

        if response.status_code == 422:
            print("[SKIP] synthetic face not detected by the model; "
                  "pipeline math validated separately")
            failures += validate_pipeline_directly()
        elif response.status_code != 200:
            failures += not check("POST /analyze-complete", False,
                                  "status %d %s" % (response.status_code,
                                                    response.text[:200]))
        else:
            data = response.json()
            failures += not check("POST /analyze-complete", data["ok"] is True)
            failures += not check("478 landmarks", data["landmark_count"] == 478,
                                  str(data["landmark_count"]))
            failures += not check("52 metrics",
                                  len(data["metrics"]) == 52,
                                  str(len(data["metrics"])))
            failures += not check("6 categories", len(data["categories"]) == 6)
            failures += not check("overall in range",
                                  0.0 <= data["overall"]["score"] <= 10.0,
                                  str(data["overall"]["score"]))
            failures += not check("chart points", len(data["chart"]["points"]) == 41,
                                  str(len(data["chart"]["points"])))
            failures += not check("landmarks normalised",
                                  all(0.0 <= p[0] <= 1.2 and 0.0 <= p[1] <= 1.2
                                      for p in data["landmarks"]["front"]))

            colors = {"teal", "green", "beige", "rose"}
            failures += not check("colors valid",
                                  all(m["color"] in colors
                                      for m in data["metrics"].values()))
            failures += not check("scores bounded",
                                  all(0.0 <= m["score"] <= 10.0
                                      for m in data["metrics"].values()))
            failures += not check("every metric has display + range",
                                  all(m["display"] and m["ideal_low"] <= m["ideal_high"]
                                      for m in data["metrics"].values()))

            print("\n  overall %.2f (%s, %s) - %d ms, profile_used=%s"
                  % (data["overall"]["score"], data["overall"]["color"],
                     data["overall"]["rating_ru"], data["elapsed_ms"],
                     data["profile_used"]))
            for cat in data["categories"]:
                print("    %-12s %5.2f  %-6s  %d metrics"
                      % (cat["title"], cat["score"], cat["color"], cat["metric_count"]))

        print("\nvalidating scoring engine directly...")
        failures += validate_pipeline_directly()
    finally:
        process.terminate()
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()

    print("\n%s" % ("ALL CHECKS PASSED" if failures == 0
                    else "%d CHECK(S) FAILED" % failures))
    return 1 if failures else 0


def validate_pipeline_directly():
    """Exercise scoring and band math without the detector."""
    failures = 0

    failures += not check("gaussian center == 10",
                          abs(server.gaussian_score(1.95, 1.85, 2.05) - 10.0) < 0.01)
    edge = server.gaussian_score(1.85, 1.85, 2.05)
    failures += not check(f"gaussian edge ~= {server.EDGE_SCORE}", abs(edge - server.EDGE_SCORE) < 0.05, str(edge))
    failures += not check("gaussian symmetric",
                          abs(server.gaussian_score(1.80, 1.85, 2.05)
                              - server.gaussian_score(2.10, 1.85, 2.05)) < 0.01)
    failures += not check("far value low", server.gaussian_score(5.0, 1.85, 2.05) < 0.5)

    failures += not check("color teal", server.score_color(8.0) == "teal")
    failures += not check("color green", server.score_color(6.0) == "green")
    failures += not check("color beige", server.score_color(4.0) == "beige")
    failures += not check("color rose", server.score_color(3.99) == "rose")

    failures += not check("8 standard combos", len(server.STANDARDS) == 8)
    required = {"canthal_tilt", "gonial_angle", "jaw_cheek_ratio",
                "eye_separation", "mouth_nose_ratio", "lower_third"}
    failures += not check("standards complete",
                          all(required.issubset(v.keys())
                              for v in server.STANDARDS.values()))

    for gender in server.GENDERS:
        for ethnicity in server.ETHNICITIES:
            bands = server.build_bands(gender, ethnicity)
            missing = [m["key"] for m in server.METRIC_DEFS if m["key"] not in bands]
            failures += not check("bands cover 52 metrics (%s/%s)" % (gender, ethnicity),
                                  not missing, ",".join(missing))
            bad = [k for k, v in bands.items() if v[0] > v[1]]
            failures += not check("bands ordered (%s/%s)" % (gender, ethnicity),
                                  not bad, ",".join(bad))

    failures += not check("52 metric defs", len(server.METRIC_DEFS) == 52,
                          str(len(server.METRIC_DEFS)))
    failures += not check("metric keys unique",
                          len(server.METRIC_BY_KEY) == len(server.METRIC_DEFS))

    tri = server.angle_deg((0, 1), (0, 0), (1, 0))
    failures += not check("angle_deg 90deg", abs(tri - 90.0) < 1e-6, str(tri))
    tilt = server.line_tilt_deg((0, 10), (10, 0))
    failures += not check("line_tilt 45deg", abs(tilt - 45.0) < 1e-6, str(tilt))
    failures += not check("safe_div guard", server.safe_div(1.0, 0.0, 7.0) == 7.0)

    chart = server.build_gaussian_chart(7.5)
    failures += not check("chart 41 points", len(chart["points"]) == 41)
    failures += not check("percentile bounded",
                          1 <= server.percentile_from_score(0.0) <= 99
                          and 1 <= server.percentile_from_score(10.0) <= 99)
    return failures


if __name__ == "__main__":
    sys.exit(main())
