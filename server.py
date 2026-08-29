"""
FACE LAB - facial analysis backend.

Pipeline:
    upload (front + optional profile)  ->  MediaPipe FaceLandmarker (478 landmarks)
    ->  geometric metrics + pixel-based skin/hair metrics
    ->  gaussian scoring against (gender, ethnicity) reference bands
    ->  JSON consumed by the static frontend.

IMPORTANT NOTE ON THE REFERENCE BANDS
-------------------------------------
The values in STANDARDS are heuristic aesthetic reference bands assembled for this
product. They are NOT clinical anthropometric norms and must not be presented as
medical or scientific ground truth. They exist to make the scoring engine
deterministic and explainable.

Run:
    pip install -r requirements.txt
    python server.py
    open http://127.0.0.1:8000
"""

from __future__ import annotations

import io
import math
import os
import sys
import time
import json
import urllib.request
import traceback
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional, Sequence, Tuple

import asyncio
import cv2
import numpy as np
from PIL import Image, ImageOps
from pydantic import BaseModel
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

# ---------------------------------------------------------------------------
# Paths / constants
# ---------------------------------------------------------------------------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
ANALYSIS_DIR = os.path.join(STATIC_DIR, "analysis")
DETAILS_DIR = os.path.join(STATIC_DIR, "details")
MODEL_DIR = os.path.join(BASE_DIR, "models")
MODEL_PATH = os.path.join(MODEL_DIR, "face_landmarker.task")
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)

MAX_UPLOAD_BYTES = 18 * 1024 * 1024
MAX_WORK_SIZE = 1400          # longest side used for landmark detection
EDGE_SCORE = 6.2              # strict Looksmaxxing score at the edge of an ideal band (was 8.7)

COLOR_TEAL = "teal"
COLOR_GREEN = "green"
COLOR_BEIGE = "beige"
COLOR_ROSE = "rose"

CATEGORY_ORDER = ["harmony", "angularity", "dimorphism", "features", "skin", "hair"]

CATEGORY_META: Dict[str, Dict[str, Any]] = {
    "harmony": {"title": "Harmony", "title_ru": "Гармония", "weight": 0.26, "icon": "◈"},
    "angularity": {"title": "Angularity", "title_ru": "Угловатость", "weight": 0.22, "icon": "◆"},
    "dimorphism": {"title": "Dimorphism", "title_ru": "Диморфизм", "weight": 0.20, "icon": "◇"},
    "features": {"title": "Features", "title_ru": "Черты лица", "weight": 0.18, "icon": "○"},
    "skin": {"title": "Skin", "title_ru": "Кожа", "weight": 0.08, "icon": "◍"},
    "hair": {"title": "Hair", "title_ru": "Волосы", "weight": 0.06, "icon": "◐"},
}

GENDERS = ("male", "female")
ETHNICITIES = ("caucasian", "asian", "african", "middle_eastern")

# ---------------------------------------------------------------------------
# Landmark indices (MediaPipe FaceMesh / FaceLandmarker, 478 points)
# ---------------------------------------------------------------------------

LM_TRICHION = 10          # top of forehead
LM_FOREHEAD_MID = 151
LM_GLABELLA = 9           # between brows
LM_NASION = 168           # root of nose
LM_NOSE_TIP = 1
LM_SUBNASALE = 2          # base of nose / above upper lip
LM_UPPER_LIP_OUTER = 0    # cupid's bow
LM_UPPER_LIP_INNER = 13
LM_LOWER_LIP_INNER = 14
LM_LOWER_LIP_OUTER = 17
LM_MENTON = 152           # bottom of chin

LM_EYE_L_OUTER = 33
LM_EYE_L_INNER = 133
LM_EYE_L_TOP = 159
LM_EYE_L_BOTTOM = 145
LM_EYE_R_OUTER = 263
LM_EYE_R_INNER = 362
LM_EYE_R_TOP = 386
LM_EYE_R_BOTTOM = 374

LM_BROW_L_TOP = 105
LM_BROW_L_OUTER = 46
LM_BROW_L_INNER = 55
LM_BROW_R_TOP = 334
LM_BROW_R_OUTER = 276
LM_BROW_R_INNER = 285

LM_ALA_L = 129
LM_ALA_R = 358
LM_NOSTRIL_L = 98
LM_NOSTRIL_R = 327

LM_MOUTH_L = 61
LM_MOUTH_R = 291

LM_ZYGO_L = 234          # widest cheek, image-left
LM_ZYGO_R = 454          # widest cheek, image-right
LM_TEMPLE_L = 127
LM_TEMPLE_R = 356
LM_GONION_L = 132        # jaw angle, image-left (corrected from 172)
LM_GONION_R = 288        # jaw angle, image-right (corrected from 397)
LM_JAW_L_MID = 172       # jawline mid-left (was gonion, now jawline mid)
LM_JAW_R_MID = 397       # jawline mid-right (was gonion, now jawline mid)
LM_CHIN_L = 150          # chin-level left jawline
LM_CHIN_R = 378          # chin-level right jawline
LM_CHEEK_L = 205
LM_CHEEK_R = 425
LM_UNDEREYE_L = 230
LM_UNDEREYE_R = 450

MIDLINE_POINTS = (10, 151, 9, 168, 1, 2, 0, 17, 152)

SYMMETRY_PAIRS: Tuple[Tuple[int, int], ...] = (
    (33, 263),
    (133, 362),
    (61, 291),
    (129, 358),
    (234, 454),
    (132, 288),
    (105, 334),
    (46, 276),
    (159, 386),
    (145, 374),
)

FACE_OVAL_IDX: Tuple[int, ...] = (
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
    378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
    162, 21, 54, 103, 67, 109,
)


# ---------------------------------------------------------------------------
# Reference bands: STANDARDS[(gender, ethnicity)] -> {metric: (lo, hi)}
# ---------------------------------------------------------------------------

STANDARDS: Dict[Tuple[str, str], Dict[str, Tuple[float, float]]] = {
    ("male", "caucasian"): {
        "canthal_tilt": (2.0, 8.0),
        "gonial_angle": (115.0, 135.0),
        "jaw_cheek_ratio": (0.55, 0.80),
        "eye_separation": (38.0, 47.0),
        "mouth_nose_ratio": (1.25, 1.60),
        "lower_third": (33.0, 42.0),
    },
    ("female", "caucasian"): {
        "canthal_tilt": (3.5, 9.0),
        "gonial_angle": (118.0, 138.0),
        "jaw_cheek_ratio": (0.50, 0.75),
        "eye_separation": (38.5, 47.5),
        "mouth_nose_ratio": (1.28, 1.62),
        "lower_third": (32.0, 41.0),
    },
    ("male", "asian"): {
        "canthal_tilt": (3.5, 9.0),
        "gonial_angle": (117.0, 137.0),
        "jaw_cheek_ratio": (0.58, 0.82),
        "eye_separation": (38.5, 47.5),
        "mouth_nose_ratio": (1.25, 1.58),
        "lower_third": (32.0, 41.5),
    },
    ("female", "asian"): {
        "canthal_tilt": (5.0, 10.5),
        "gonial_angle": (120.0, 140.0),
        "jaw_cheek_ratio": (0.52, 0.77),
        "eye_separation": (39.0, 48.0),
        "mouth_nose_ratio": (1.28, 1.62),
        "lower_third": (31.5, 41.0),
    },
    ("male", "african"): {
        "canthal_tilt": (3.0, 8.0),
        "gonial_angle": (113.0, 133.0),
        "jaw_cheek_ratio": (0.58, 0.83),
        "eye_separation": (38.0, 47.0),
        "mouth_nose_ratio": (1.22, 1.55),
        "lower_third": (33.0, 42.5),
    },
    ("female", "african"): {
        "canthal_tilt": (4.5, 9.5),
        "gonial_angle": (116.0, 136.0),
        "jaw_cheek_ratio": (0.53, 0.78),
        "eye_separation": (38.5, 47.5),
        "mouth_nose_ratio": (1.25, 1.58),
        "lower_third": (32.5, 42.0),
    },
    ("male", "middle_eastern"): {
        "canthal_tilt": (2.0, 8.0),
        "gonial_angle": (114.0, 134.0),
        "jaw_cheek_ratio": (0.56, 0.81),
        "eye_separation": (38.0, 47.0),
        "mouth_nose_ratio": (1.25, 1.60),
        "lower_third": (32.5, 42.0),
    },
    ("female", "middle_eastern"): {
        "canthal_tilt": (3.5, 9.0),
        "gonial_angle": (117.0, 137.0),
        "jaw_cheek_ratio": (0.51, 0.76),
        "eye_separation": (38.5, 47.5),
        "mouth_nose_ratio": (1.28, 1.62),
        "lower_third": (32.0, 41.5),
    },
}

# Bands that do not vary by ethnicity in this model.
GENERIC_BANDS: Dict[str, Tuple[float, float]] = {
    "facial_thirds_balance": (60.0, 98.0),
    "vertical_symmetry": (92.0, 100.0),
    "horizontal_symmetry": (92.0, 100.0),
    "golden_ratio": (1.32, 1.65),
    "midface_ratio": (0.44, 0.56),
    "cheekbone_prominence": (1.08, 1.30),
    "jaw_frontal_angle": (70.0, 110.0),
    "chin_width_ratio": (0.22, 0.42),
    "mandible_definition": (1.20, 1.62),
    "ramus_ratio": (0.40, 0.80),
    "bigonial_width": (0.45, 0.68),
    "chin_projection": (162.0, 174.0),
    "jaw_mass": (0.30, 0.40),
    "eye_aperture": (0.30, 0.38),
    "face_length_ratio": (1.20, 1.55),
    "cheek_fullness": (0.20, 0.30),
    "brow_tilt": (4.0, 12.0),
    "dimorphism_index": (55.0, 100.0),
    "eye_size": (0.215, 0.255),
    "nose_width": (0.245, 0.290),
    "lip_width": (0.360, 0.420),
    "nose_length": (0.400, 0.460),
    "nasal_index": (0.60, 0.72),
    "philtrum_length": (0.055, 0.085),
    "upper_lip_ratio": (0.62, 0.85),
    "eye_spacing_symmetry": (94.0, 100.0),
    "nose_height_ratio": (0.30, 0.38),
    "interocular_ratio": (0.85, 1.25),
    "mouth_width_ratio": (1.42, 1.62),
    "chin_height_ratio": (0.26, 0.34),
    "skin_tone_ita": (10.0, 55.0),
    "skin_evenness": (78.0, 100.0),
    "skin_redness": (4.0, 13.0),
    "skin_clarity": (72.0, 100.0),
    "skin_texture": (18.0, 42.0),
    "undereye_darkness": (0.0, 6.0),
    "skin_shine": (0.5, 5.0),
    "skin_contrast": (3.0, 11.0),
    "hair_coverage": (62.0, 100.0),
    "hairline_height": (10.0, 20.0),
    "hair_density": (66.0, 100.0),
    "hair_shine": (4.0, 16.0),
    "hair_darkness": (35.0, 85.0),
    "hair_uniformity": (70.0, 100.0),
}

# Per-gender overrides applied on top of GENERIC_BANDS.
GENDER_BAND_OVERRIDES: Dict[str, Dict[str, Tuple[float, float]]] = {
    "male": {
        "brow_ridge": (0.052, 0.082),
        "lip_thickness": (0.30, 0.40),
        "jaw_mass": (0.25, 0.45),
        "eye_aperture": (0.28, 0.35),
        "cheek_fullness": (0.18, 0.27),
        "brow_tilt": (2.0, 9.0),
        "eye_size": (0.210, 0.248),
        "upper_lip_ratio": (0.60, 0.82),
        "hairline_height": (11.0, 22.0),
    },
    "female": {
        "brow_ridge": (0.030, 0.058),
        "lip_thickness": (0.36, 0.48),
        "jaw_mass": (0.20, 0.40),
        "eye_aperture": (0.32, 0.40),
        "cheek_fullness": (0.23, 0.33),
        "brow_tilt": (6.0, 14.0),
        "eye_size": (0.222, 0.262),
        "upper_lip_ratio": (0.66, 0.88),
        "hairline_height": (8.0, 17.0),
    },
}

# ---------------------------------------------------------------------------
# Metric registry: 52 metrics across 6 categories
# ---------------------------------------------------------------------------

METRIC_DEFS: Tuple[Dict[str, Any], ...] = (
    # ---- harmony (12) ----
    {"key": "canthal_tilt", "cat": "harmony", "label": "Canthal Tilt", "unit": "°",
     "ru": "Наклон линии глаза от внутреннего к внешнему уголку. Положительный наклон читается как открытый взгляд."},
    {"key": "lower_third", "cat": "harmony", "label": "Lower Third", "unit": "%",
     "ru": "Доля нижней трети лица: от основания носа до нижней точки подбородка."},
    {"key": "eye_separation", "cat": "harmony", "label": "Eye Separation", "unit": "%",
     "ru": "Расстояние между центрами зрачков относительно ширины лица."},
    {"key": "mouth_nose_ratio", "cat": "harmony", "label": "Mouth to Nose Ratio", "unit": "",
     "ru": "Отношение ширины рта к ширине носа. Классический показатель баланса нижней зоны."},
    {"key": "facial_thirds_balance", "cat": "harmony", "label": "Facial Thirds Balance", "unit": "%",
     "ru": "Насколько три горизонтальные зоны лица близки к равным долям."},
    {"key": "vertical_symmetry", "cat": "harmony", "label": "Vertical Symmetry", "unit": "%",
     "ru": "Симметрия парных точек относительно вертикальной оси лица."},
    {"key": "horizontal_symmetry", "cat": "harmony", "label": "Horizontal Symmetry", "unit": "%",
     "ru": "Совпадение высот парных точек слева и справа."},
    {"key": "golden_ratio", "cat": "harmony", "label": "Golden Ratio", "unit": "",
     "ru": "Отношение высоты лица к его ширине в сравнении с золотым сечением 1.618."},
    {"key": "midface_ratio", "cat": "harmony", "label": "Midface Ratio", "unit": "",
     "ru": "Компактность средней зоны: расстояние от зрачков до основания носа относительно ширины лица."},
    {"key": "face_length_ratio", "cat": "harmony", "label": "Face Length Ratio", "unit": "",
     "ru": "Общая пропорция высоты лица к ширине. Показывает вытянутость овала."},
    {"key": "interocular_ratio", "cat": "harmony", "label": "Interocular Ratio", "unit": "",
     "ru": "Отношение межглазного расстояния к длине глазной щели. В идеале близко к 1."},
    {"key": "eye_spacing_symmetry", "cat": "harmony", "label": "Eye Spacing Symmetry", "unit": "%",
     "ru": "Насколько одинаково удалены левый и правый глаз от центральной оси."},

    # ---- angularity (10) ----
    {"key": "gonial_angle", "cat": "angularity", "label": "Gonial Angle", "unit": "°",
     "ru": "Угол нижней челюсти в точке гониона. Меньший угол даёт более резкую линию челюсти."},
    {"key": "cheekbone_prominence", "cat": "angularity", "label": "Cheekbone Prominence", "unit": "",
     "ru": "Выступание скул относительно ширины на уровне висков."},
    {"key": "jaw_cheek_ratio", "cat": "angularity", "label": "Jaw to Cheek Ratio", "unit": "",
     "ru": "Отношение ширины челюсти к ширине скул. Формирует общий силуэт лица."},
    {"key": "jaw_frontal_angle", "cat": "angularity", "label": "Jaw Frontal Angle", "unit": "°",
     "ru": "Угол схождения линий челюсти к подбородку во фронтальной проекции."},
    {"key": "chin_width_ratio", "cat": "angularity", "label": "Chin Width Ratio", "unit": "",
     "ru": "Ширина подбородка относительно ширины челюсти."},
    {"key": "mandible_definition", "cat": "angularity", "label": "Mandible Definition", "unit": "",
     "ru": "Композитный индекс чёткости нижней челюсти: сочетает угол гониона и ширину."},
    {"key": "ramus_ratio", "cat": "angularity", "label": "Ramus Ratio", "unit": "",
     "ru": "Отношение восходящей ветви челюсти к её горизонтальной части."},
    {"key": "bigonial_width", "cat": "angularity", "label": "Bigonial Width", "unit": "",
     "ru": "Ширина между точками гониона относительно высоты лица."},
    {"key": "chin_projection", "cat": "angularity", "label": "Chin Projection", "unit": "°",
     "ru": "Выступание подбородка. При загруженном профиле считается по боковому снимку."},
    {"key": "jaw_mass", "cat": "angularity", "label": "Jaw Mass", "unit": "",
     "ru": "Визуальная массивность нижней зоны относительно всего лица."},

    # ---- dimorphism (7) ----
    {"key": "brow_ridge", "cat": "dimorphism", "label": "Brow Ridge", "unit": "",
     "ru": "Выраженность надбровной дуги: расстояние от брови до верхнего края глаза."},
    {"key": "lip_thickness", "cat": "dimorphism", "label": "Lip Thickness", "unit": "",
     "ru": "Суммарная толщина губ относительно ширины рта."},
    {"key": "dimorphism_index", "cat": "dimorphism", "label": "Dimorphism Index", "unit": "%",
     "ru": "Сводный индекс соответствия черт выбранному полу."},
    {"key": "brow_tilt", "cat": "dimorphism", "label": "Brow Tilt", "unit": "°",
     "ru": "Наклон брови от внутреннего к внешнему краю."},
    {"key": "eye_aperture", "cat": "dimorphism", "label": "Eye Aperture", "unit": "",
     "ru": "Раскрытость глаза: высота глазной щели относительно её длины."},
    {"key": "cheek_fullness", "cat": "dimorphism", "label": "Cheek Fullness", "unit": "",
     "ru": "Наполненность зоны щёк, влияет на восприятие мягкости черт."},
    {"key": "chin_height_ratio", "cat": "dimorphism", "label": "Chin Height Ratio", "unit": "",
     "ru": "Высота подбородка относительно нижней трети лица."},

    # ---- features (9) ----
    {"key": "eye_size", "cat": "features", "label": "Eye Size", "unit": "",
     "ru": "Длина глазной щели относительно ширины лица."},
    {"key": "nose_width", "cat": "features", "label": "Nose Width", "unit": "",
     "ru": "Ширина крыльев носа относительно ширины лица."},
    {"key": "lip_width", "cat": "features", "label": "Lip Width", "unit": "",
     "ru": "Ширина рта относительно ширины лица."},
    {"key": "nose_length", "cat": "features", "label": "Nose Length", "unit": "",
     "ru": "Длина носа от переносицы до основания относительно ширины лица."},
    {"key": "nasal_index", "cat": "features", "label": "Nasal Index", "unit": "",
     "ru": "Отношение ширины носа к его длине. Классический носовой индекс."},
    {"key": "philtrum_length", "cat": "features", "label": "Philtrum Length", "unit": "",
     "ru": "Длина фильтрума: от основания носа до верхней губы."},
    {"key": "upper_lip_ratio", "cat": "features", "label": "Upper to Lower Lip", "unit": "",
     "ru": "Отношение толщины верхней губы к нижней."},
    {"key": "nose_height_ratio", "cat": "features", "label": "Nose Height Ratio", "unit": "",
     "ru": "Высота носа относительно высоты лица."},
    {"key": "mouth_width_ratio", "cat": "features", "label": "Mouth Width Ratio", "unit": "",
     "ru": "Ширина рта относительно межзрачкового расстояния."},

    # ---- skin (8) ----
    {"key": "skin_tone_ita", "cat": "skin", "label": "Skin Tone ITA", "unit": "°",
     "ru": "Индивидуальный типологический угол — объективная мера светлоты кожи."},
    {"key": "skin_evenness", "cat": "skin", "label": "Skin Evenness", "unit": "%",
     "ru": "Ровность тона по зонам лица: чем выше, тем однороднее цвет."},
    {"key": "skin_redness", "cat": "skin", "label": "Skin Redness", "unit": "",
     "ru": "Уровень покраснения по красно-зелёной оси цветового пространства Lab."},
    {"key": "skin_clarity", "cat": "skin", "label": "Skin Clarity", "unit": "%",
     "ru": "Чистота кожи: оценка по количеству локальных неоднородностей."},
    {"key": "skin_texture", "cat": "skin", "label": "Skin Texture", "unit": "",
     "ru": "Микрорельеф поверхности кожи по высокочастотной составляющей изображения."},
    {"key": "undereye_darkness", "cat": "skin", "label": "Undereye Darkness", "unit": "",
     "ru": "Затемнение под глазами относительно тона щеки."},
    {"key": "skin_shine", "cat": "skin", "label": "Skin Shine", "unit": "%",
     "ru": "Площадь пересветов на коже. Указывает на жирность или засветку кадра."},
    {"key": "skin_contrast", "cat": "skin", "label": "Skin Contrast", "unit": "",
     "ru": "Разброс светлоты внутри области лица."},

    # ---- hair (6) ----
    {"key": "hair_coverage", "cat": "hair", "label": "Hair Coverage", "unit": "%",
     "ru": "Заполненность зоны волос над линией роста в кадре."},
    {"key": "hairline_height", "cat": "hair", "label": "Hairline Height", "unit": "%",
     "ru": "Высота линии роста волос относительно высоты лица."},
    {"key": "hair_density", "cat": "hair", "label": "Hair Density", "unit": "%",
     "ru": "Плотность волос по насыщенности тёмных пикселей в зоне волос."},
    {"key": "hair_shine", "cat": "hair", "label": "Hair Shine", "unit": "%",
     "ru": "Блеск волос по доле светлых блик-пикселей."},
    {"key": "hair_darkness", "cat": "hair", "label": "Hair Darkness", "unit": "%",
     "ru": "Глубина тона волос: 0 — очень светлые, 100 — очень тёмные."},
    {"key": "hair_uniformity", "cat": "hair", "label": "Hair Uniformity", "unit": "%",
     "ru": "Однородность цвета волос по зоне."},
)

METRIC_BY_KEY: Dict[str, Dict[str, Any]] = {m["key"]: m for m in METRIC_DEFS}
METRICS_BY_CAT: Dict[str, List[str]] = {c: [] for c in CATEGORY_ORDER}
for _m in METRIC_DEFS:
    METRICS_BY_CAT[_m["cat"]].append(_m["key"])


def build_bands(gender: str, ethnicity: str) -> Dict[str, Tuple[float, float]]:
    """Merge generic, gender and (gender, ethnicity) bands into one table."""
    bands: Dict[str, Tuple[float, float]] = dict(GENERIC_BANDS)
    bands.update(GENDER_BAND_OVERRIDES.get(gender, {}))
    bands.update(STANDARDS.get((gender, ethnicity), {}))
    return bands


# ---------------------------------------------------------------------------
# Scoring engine
# ---------------------------------------------------------------------------

def band_sigma(lo: float, hi: float) -> float:
    """Sigma so that a value exactly on the band edge scores EDGE_SCORE."""
    half = max(abs(hi - lo) / 2.0, 1e-6)
    return half / math.sqrt(2.0 * math.log(10.0 / EDGE_SCORE))


def gaussian_score(value: float, lo: float, hi: float) -> float:
    """score = 10 * exp(-((value - center)^2) / (2 * sigma^2)), with strict Looksmaxxing decay beyond band."""
    center = (lo + hi) / 2.0
    sigma = band_sigma(lo, hi)
    dist_val = abs(value - center)
    half = max(abs(hi - lo) / 2.0, 1e-6)
    if dist_val <= half:
        raw = 10.0 * math.exp(-(dist_val ** 2) / (2.0 * sigma * sigma))
    else:
        extra = (dist_val - half) / half
        raw = EDGE_SCORE / (1.0 + 1.25 * (extra ** 1.25))
    return round(max(0.0, min(10.0, raw)), 2)


def score_color(score: float) -> str:
    if score >= 7.2:
        return COLOR_TEAL
    if score >= 5.8:
        return COLOR_GREEN
    if score >= 4.0:
        return COLOR_BEIGE
    return COLOR_ROSE


def score_label_ru(score: float) -> str:
    if score >= 8.5:
        return "Chico / Chad Tier (Топ 1%)"
    if score >= 7.2:
        return "Chadlite / Топ-модель (Топ 10%)"
    if score >= 5.8:
        return "High Tier Normie (HTN)"
    if score >= 4.5:
        return "Mid Tier Normie (MTN)"
    if score >= 3.2:
        return "Low Tier Normie (LTN)"
    return "Требуется Hardmaxxing"


def percentile_from_score(score: float) -> int:
    """Map a 0..10 score onto a readable percentile figure."""
    pct = 100.0 / (1.0 + math.exp(-(score - 5.6) * 0.78))
    return int(round(max(1.0, min(99.0, pct))))


def direction_hint(value: float, lo: float, hi: float) -> str:
    center = (lo + hi) / 2.0
    if value < lo:
        return "below"
    if value > hi:
        return "above"
    if value < center:
        return "in_low"
    return "in_high"


def direction_text_ru(hint: str) -> str:
    return {
        "below": "ниже референсного диапазона",
        "above": "выше референсного диапазона",
        "in_low": "в диапазоне, ближе к нижней границе",
        "in_high": "в диапазоне, ближе к верхней границе",
    }[hint]


def advice_text_ru(key: str, hint: str, score: float) -> str:
    """Short actionable advice per metric based on direction and score."""
    if score >= 8.0:
        return "Сохраняйте текущий уход и образ жизни — показатель в норме."
    base = {
        "canthal_tilt": "Угол глаз определён анатомически. Макияж или укладка бровей могут визуально скорректировать наклон.",
        "gonial_angle": "Угол челюсти зависит от анатомии. Снижение массы жировой ткани в зоне нижней челюсти делает линию резче.",
        "jaw_cheek_ratio": "Соотношение ширины челюсти и скул можно сместить за счёт управления массой тела и тренировки жевательных мышц.",
        "eye_separation": "Межглазное расстояние — фиксированная анатомика. Подбор очков и бровей по форме лица помогает визуально сбалансировать.",
        "mouth_nose_ratio": "Соотношение рта и носа можно скорректировать контурингом губ или ринопластикой.",
        "lower_third": "Доля нижней трети зависит от анатомии подбородка. Импланты или филлеры могут увеличить проекцию.",
        "facial_thirds_balance": "Баланс третей — анатомическая особенность. Контуринг и укладка помогают визуально выровнять зоны.",
        "vertical_symmetry": "Асимметрия лица частично корректируется миофасциальным массажем и осанкой.",
        "horizontal_symmetry": "Горизонтальная симметрия улучшается при работе с осанкой и жевательными привычками.",
        "golden_ratio": "Пропорция лица — анатомическая. Причёска и борода могут визуально вытянуть или расширить овал.",
        "midface_ratio": "Компактность средней зоны — анатомический показатель. Контуринг носа и скул помогает визуально.",
        "face_length_ratio": "Соотношение высоты и ширины — анатомическое. Причёска и головной убор влияют на восприятие.",
        "interocular_ratio": "Межглазное расстояние — фиксированная анатомика. Очки и макияж корректируют восприятие.",
        "eye_spacing_symmetry": "Симметрия глазных расстояний зависит от анатомии. Осанка и массаж могут помочь.",
        "cheekbone_prominence": "Выступание скул усиливается снижением массы жировой ткани и контурингом.",
        "jaw_frontal_angle": "Угол схождения челюсти — анатомический. Управление массой тела влияет на визуальную резкость.",
        "chin_width_ratio": "Ширина подбородка — анатомическая. Филлеры или импланты корректируют пропорцию.",
        "mandible_definition": "Чёткость челюсти повышается при снижении жировой ткани и тренировке жевательных мышц.",
        "ramus_ratio": "Соотношение ветви челюсти — анатомическое. Изменить можно только хирургически.",
        "bigonial_width": "Ширина челюсти зависит от анатомии и массы жевательных мышц. Избегайте перетренированности жевательных мышц.",
        "chin_projection": "Проекция подбородка — анатомическая. Филлеры, импланты или ментопластика корректируют.",
        "jaw_mass": "Массивность челюсти зависит от жевательных мышц и массы тела. Снижение массы тела делает зону легче.",
        "brow_ridge": "Выраженность надбровной дуги — анатомическая. Брови и макияж корректируют восприятие.",
        "lip_thickness": "Толщина губ корректируется филерами или макияжем.",
        "dimorphism_index": "Сводный индекс диморфизма зависит от комбинации черт. Гормональный фон и образ жизни влияют.",
        "brow_tilt": "Наклон бровей можно корректировать укладкой, пинцетом или микроблейдингом.",
        "eye_aperture": "Раскрытость глаз зависит от анатомии и отёчности. Качественный сон и уход за кожей век помогают.",
        "cheek_fullness": "Наполненность щёк зависит от массы жировой ткани и возраста. Контуринг и филлеры корректируют.",
        "chin_height_ratio": "Высота подбородка — анатомическая. Импланты или филлеры меняют пропорцию.",
        "eye_size": "Размер глаз — анатомический. Макияж и ресницы визуально увеличивают.",
        "nose_width": "Ширина носа — анатомическая. Контуринг или ринопластика корректируют.",
        "lip_width": "Ширина рта — анатомическая. Контуринг губ визуально меняет пропорцию.",
        "nose_length": "Длина носа — анатомическая. Контуринг или ринопластика корректируют.",
        "nasal_index": "Носовой индекс — анатомический. Контуринг и ринопластика корректируют.",
        "philtrum_length": "Длина фильтрума меняется с возрастом. Филлеры верхней губы корректируют.",
        "upper_lip_ratio": "Соотношение губ корректируется филерами или макияжем.",
        "nose_height_ratio": "Высота носа — анатомическая. Ринопластика меняет пропорцию.",
        "mouth_width_ratio": "Ширина рта — анатомическая. Контуринг губ визуально корректирует.",
        "skin_tone_ita": "Тон кожи зависит от генетики и загара. SPF и уход выравнивают.",
        "skin_evenness": "Ровность тона улучшается SPF, ретинолом, витамином С и пилингами.",
        "skin_redness": "Покраснение снижается успокаивающим уходом, ниацинамидом и азелаиновой кислотой.",
        "skin_clarity": "Чистота кожи улучшается регулярным очищением, салициловой кислотой и ретиноидами.",
        "skin_texture": "Микрорельф выравнивается ретинолом, пилингами и увлажнением.",
        "undereye_darkness": "Тёмные круги уменьшаются сном, витамином К, кофеином и консилером.",
        "skin_shine": "Жирность контролируется ниацинамидом, матирующими средствами и умыванием.",
        "skin_contrast": "Контраст кожи выравнивается SPF, тониками и увлажнением.",
        "hair_coverage": "Покрытие волос зависит от густоты и укладки. Миноксидил и финастерид помогают при поредении.",
        "hairline_height": "Линия роста волос — генетика. Миноксидил и трансплантация корректируют.",
        "hair_density": "Плотность волос зависит от питания и ухода. Миноксидил и массаж кожи головы стимулируют.",
        "hair_shine": "Блеск волос улучшается увлажнением, масками и холодным ополаскиванием.",
        "hair_darkness": "Тон волос зависит от пигмента. Окрашивание и тонирование меняют глубину.",
        "hair_uniformity": "Однородность цвета достигается тонированием и уходом за длиной.",
    }
    text = base.get(key)
    if not text:
        return "Показатель зависит от анатомии и образа жизни."
    if hint in ("in_low", "in_high") and score >= 6.0:
        return "Показатель в пределах нормы. " + text
    return text


def build_metric_result(key: str, value: float, bands: Dict[str, Tuple[float, float]],
                        source: str) -> Dict[str, Any]:
    definition = METRIC_BY_KEY[key]
    lo, hi = bands.get(key, (0.0, 1.0))
    value = float(round(value, 4))
    score = gaussian_score(value, lo, hi)
    hint = direction_hint(value, lo, hi)
    return {
        "key": key,
        "label": definition["label"],
        "category": definition["cat"],
        "unit": definition["unit"],
        "description_ru": definition["ru"],
        "value": value,
        "display": format_value(value, definition["unit"]),
        "ideal_low": round(lo, 4),
        "ideal_high": round(hi, 4),
        "ideal_center": round((lo + hi) / 2.0, 4),
        "sigma": round(band_sigma(lo, hi), 4),
        "score": score,
        "color": score_color(score),
        "rating_ru": score_label_ru(score),
        "percentile": percentile_from_score(score),
        "direction": hint,
        "direction_ru": direction_text_ru(hint),
        "advice_ru": advice_text_ru(key, hint, score),
        "source": source,
        "scale_min": round((lo + hi) / 2.0 - 3.4 * band_sigma(lo, hi), 4),
        "scale_max": round((lo + hi) / 2.0 + 3.4 * band_sigma(lo, hi), 4),
    }


def format_value(value: float, unit: str) -> str:
    if unit == "%":
        return f"{value:.1f}%"
    if unit == "°":
        return f"{value:.1f}°"
    if abs(value) < 1.0:
        return f"{value:.3f}"
    return f"{value:.2f}"


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def dist(a: Sequence[float], b: Sequence[float]) -> float:
    return float(math.hypot(a[0] - b[0], a[1] - b[1]))


def midpoint(a: Sequence[float], b: Sequence[float]) -> Tuple[float, float]:
    return ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)


def angle_deg(a: Sequence[float], vertex: Sequence[float], c: Sequence[float]) -> float:
    """Interior angle a-vertex-c in degrees."""
    v1 = (a[0] - vertex[0], a[1] - vertex[1])
    v2 = (c[0] - vertex[0], c[1] - vertex[1])
    n1 = math.hypot(*v1)
    n2 = math.hypot(*v2)
    if n1 < 1e-9 or n2 < 1e-9:
        return 0.0
    cosine = (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)
    cosine = max(-1.0, min(1.0, cosine))
    return math.degrees(math.acos(cosine))


def line_tilt_deg(inner: Sequence[float], outer: Sequence[float]) -> float:
    """Positive when the outer point sits higher than the inner point on screen."""
    dx = abs(outer[0] - inner[0])
    dy = inner[1] - outer[1]
    if dx < 1e-9:
        return 0.0
    return math.degrees(math.atan2(dy, dx))


def safe_div(numerator: float, denominator: float, fallback: float = 0.0) -> float:
    if abs(denominator) < 1e-9:
        return fallback
    return numerator / denominator


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


# ---------------------------------------------------------------------------
# Jaw contour analysis — derive jaw metrics from face oval dynamically
# ---------------------------------------------------------------------------

# Face oval ordered from chin (152) going left-up then right-up
_JAWLINE_LEFT = [152, 148, 176, 149, 150, 136, 172, 58, 132, 93]
_JAWLINE_RIGHT = [152, 377, 400, 378, 379, 365, 397, 288, 361, 323]


def jaw_contour_analysis(pts: List[Tuple[float, float]]) -> Dict[str, Any]:
    """Walk the face oval jawline and extract key jaw measurements dynamically.

    Returns a dict with:
      jaw_width   – widest distance between symmetric jawline points
      chin_width  – narrowest distance near the chin
      gonion_y    – y-coordinate of the jaw angle (widest jaw level)
      gonion_left – coordinates of the left jaw angle point
      gonion_right – coordinates of the right jaw angle point
      ramus_height – vertical distance from gonion to chin
      jaw_body_len – direct distance from gonion to chin
    """
    try:
        # Pair widths at each jawline level (skip index 0 = chin itself)
        pair_widths: List[Tuple[float, int]] = []
        for i in range(1, min(len(_JAWLINE_LEFT), len(_JAWLINE_RIGHT))):
            if _JAWLINE_LEFT[i] < len(pts) and _JAWLINE_RIGHT[i] < len(pts):
                l_pt = pts[_JAWLINE_LEFT[i]]
                r_pt = pts[_JAWLINE_RIGHT[i]]
                pair_widths.append((dist(l_pt, r_pt), i))

        # Jaw width = max width in the jaw region (indices 1-7, excluding cheekbone area)
        jaw_pairs = [pw for pw in pair_widths if pw[1] <= 7]
        if not jaw_pairs:
            jaw_pairs = pair_widths
        if jaw_pairs:
            jaw_width, gonion_level = max(jaw_pairs, key=lambda x: x[0])
        else:
            jaw_width, gonion_level = dist(pts[LM_ZYGO_L], pts[LM_ZYGO_R]) * 0.82, 4

        # Chin width = narrowest among the 3 closest points to chin
        chin_pairs = pair_widths[:3]
        chin_width = min(pw[0] for pw in chin_pairs) if chin_pairs else jaw_width * 0.35

        gonion_l = pts[_JAWLINE_LEFT[gonion_level]] if gonion_level < len(_JAWLINE_LEFT) else pts[LM_JAW_L_MID]
        gonion_r = pts[_JAWLINE_RIGHT[gonion_level]] if gonion_level < len(_JAWLINE_RIGHT) else pts[LM_JAW_R_MID]
        chin_pt = pts[152] if len(pts) > 152 else pts[LM_MENTON]

        gonion_y = (gonion_l[1] + gonion_r[1]) / 2.0
        chin_y = chin_pt[1]

        ramus_height = abs(gonion_y - chin_y)
        gonion_center = ((gonion_l[0] + gonion_r[0]) / 2.0, gonion_y)
        jaw_body_len = dist(gonion_center, chin_pt)

        return {
            "jaw_width": jaw_width,
            "chin_width": chin_width,
            "gonion_y": gonion_y,
            "gonion_left": gonion_l,
            "gonion_right": gonion_r,
            "gonion_level": gonion_level,
            "ramus_height": ramus_height,
            "jaw_body_len": jaw_body_len,
        }
    except Exception:
        face_w = dist(pts[LM_ZYGO_L], pts[LM_ZYGO_R])
        return {
            "jaw_width": face_w * 0.82,
            "chin_width": face_w * 0.28,
            "gonion_y": (pts[LM_JAW_L_MID][1] + pts[LM_JAW_R_MID][1]) / 2.0,
            "gonion_left": pts[LM_JAW_L_MID],
            "gonion_right": pts[LM_JAW_R_MID],
            "gonion_level": 4,
            "ramus_height": face_w * 0.45,
            "jaw_body_len": face_w * 0.55,
        }


# ---------------------------------------------------------------------------
# Model bootstrap + detector
# ---------------------------------------------------------------------------

def ensure_model() -> str:
    """Download the FaceLandmarker task bundle once, then reuse it."""
    os.makedirs(MODEL_DIR, exist_ok=True)
    if os.path.exists(MODEL_PATH) and os.path.getsize(MODEL_PATH) > 500_000:
        return MODEL_PATH
    print(f"[face-lab] downloading face_landmarker.task -> {MODEL_PATH}")
    request = urllib.request.Request(MODEL_URL, headers={"User-Agent": "face-lab/1.0"})
    with urllib.request.urlopen(request, timeout=180) as response:
        payload = response.read()
    if len(payload) < 500_000:
        raise RuntimeError("downloaded model looks truncated")
    tmp_path = MODEL_PATH + ".part"
    with open(tmp_path, "wb") as handle:
        handle.write(payload)
    os.replace(tmp_path, MODEL_PATH)
    print(f"[face-lab] model ready ({len(payload)} bytes)")
    return MODEL_PATH


_detector: Optional[Any] = None


def get_detector() -> Any:
    """Create the FaceLandmarker once (IMAGE running mode) and cache it."""
    global _detector
    if _detector is not None:
        return _detector
    model_path = ensure_model()
    base_options = mp_python.BaseOptions(model_asset_path=model_path)
    options = vision.FaceLandmarkerOptions(
        base_options=base_options,
        running_mode=vision.RunningMode.IMAGE,
        num_faces=1,
        min_face_detection_confidence=0.5,
        min_face_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    _detector = vision.FaceLandmarker.create_from_options(options)
    print("[face-lab] FaceLandmarker initialised")
    return _detector


def decode_upload(raw: bytes) -> np.ndarray:
    """Decode uploaded bytes into a BGR image with EXIF orientation handling and downscaling."""
    if not raw:
        raise HTTPException(status_code=400, detail="Пустой файл изображения.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Файл больше 18 МБ.")

    image: Optional[np.ndarray] = None

    # 1. Try PIL first: automatically handles smartphone EXIF orientation & HEIC/WebP/JPEG
    try:
        pil_img = Image.open(io.BytesIO(raw))
        pil_img = ImageOps.exif_transpose(pil_img)
        if pil_img.mode != "RGB":
            pil_img = pil_img.convert("RGB")
        rgb_arr = np.array(pil_img)
        image = cv2.cvtColor(rgb_arr, cv2.COLOR_RGB2BGR)
    except Exception:
        pass

    # 2. Fallback to cv2.imdecode
    if image is None:
        buffer = np.frombuffer(raw, dtype=np.uint8)
        image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)

    if image is None or image.size == 0:
        raise HTTPException(
            status_code=400,
            detail="Не удалось прочитать изображение. Загрузите фото в формате JPG или PNG."
        )

    height, width = image.shape[:2]
    longest = max(height, width)
    if longest > MAX_WORK_SIZE:
        scale = MAX_WORK_SIZE / float(longest)
        image = cv2.resize(image, (int(width * scale), int(height * scale)),
                           interpolation=cv2.INTER_AREA)
    return image


def detect_landmarks(image_bgr: np.ndarray) -> Tuple[List[Tuple[float, float]], Dict[str, float]]:
    """Return pixel-space landmarks with multi-angle rotation & contrast fallbacks."""
    detector = get_detector()

    # Pass 1: Standard orientation
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))

    # Pass 2: Phone camera rotation fallback (90 deg CW, 90 deg CCW, 180 deg)
    if not result.face_landmarks:
        for rot in (cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE, cv2.ROTATE_180):
            rotated = cv2.rotate(image_bgr, rot)
            rot_rgb = cv2.cvtColor(rotated, cv2.COLOR_BGR2RGB)
            res_rot = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rot_rgb))
            if res_rot.face_landmarks:
                image_bgr = rotated
                result = res_rot
                break

    # Pass 3: Contrast / brightness boost (CLAHE) for dim or shadowed selfie
    if not result.face_landmarks:
        try:
            lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
            clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
            lab[:, :, 0] = clahe.apply(lab[:, :, 0])
            boosted = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
            b_rgb = cv2.cvtColor(boosted, cv2.COLOR_BGR2RGB)
            res_boost = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=b_rgb))
            if res_boost.face_landmarks:
                result = res_boost
        except Exception:
            pass

    if not result.face_landmarks:
        raise HTTPException(
            status_code=422,
            detail="Лицо не найдено на фото. Пожалуйста, сфотографируйтесь прямо перед камерой при хорошем освещении (без очков и маски).",
        )

    height, width = image_bgr.shape[:2]
    points = [(lm.x * width, lm.y * height) for lm in result.face_landmarks[0]]
    shapes: Dict[str, float] = {}
    categories = getattr(result, "face_blendshapes", None)
    if categories:
        for category in categories[0]:
            shapes[category.category_name] = float(category.score)
    return points, shapes


# ---------------------------------------------------------------------------
# Frontal geometry metrics
# ---------------------------------------------------------------------------

def frontal_metrics(pts: List[Tuple[float, float]]) -> Dict[str, float]:
    """Compute every landmark-derived measurement from the frontal photo."""
    out: Dict[str, float] = {}

    face_width = dist(pts[LM_ZYGO_L], pts[LM_ZYGO_R])
    temple_width = dist(pts[LM_TEMPLE_L], pts[LM_TEMPLE_R])
    face_height = dist(pts[LM_TRICHION], pts[LM_MENTON])
    if face_width < 1e-6 or face_height < 1e-6:
        raise HTTPException(status_code=422, detail="Некорректная геометрия лица на снимке.")

    eye_l_center = midpoint(pts[LM_EYE_L_OUTER], pts[LM_EYE_L_INNER])
    eye_r_center = midpoint(pts[LM_EYE_R_OUTER], pts[LM_EYE_R_INNER])
    pupil_distance = dist(eye_l_center, eye_r_center)

    brow_line_y = (pts[LM_BROW_L_TOP][1] + pts[LM_BROW_R_TOP][1]) / 2.0
    subnasale_y = pts[LM_SUBNASALE][1]
    trichion_y = pts[LM_TRICHION][1]
    menton_y = pts[LM_MENTON][1]

    # --- canthal tilt, averaged over both eyes ---
    tilt_left = line_tilt_deg(pts[LM_EYE_L_INNER], pts[LM_EYE_L_OUTER])
    tilt_right = line_tilt_deg(pts[LM_EYE_R_INNER], pts[LM_EYE_R_OUTER])
    out["canthal_tilt"] = (tilt_left + tilt_right) / 2.0

    # --- facial thirds as percentages of total face height ---
    top = max(brow_line_y - trichion_y, 1e-6)
    middle = max(subnasale_y - brow_line_y, 1e-6)
    lower = max(menton_y - subnasale_y, 1e-6)
    total = top + middle + lower
    out["lower_third"] = 100.0 * lower / total

    thirds = (100.0 * top / total, 100.0 * middle / total, out["lower_third"])
    spread = max(thirds) - min(thirds)
    out["facial_thirds_balance"] = clamp(100.0 - spread * 1.5, 60.0, 100.0)

    out["eye_separation"] = 100.0 * safe_div(pupil_distance, face_width, 0.45)
    out["mouth_nose_ratio"] = safe_div(dist(pts[LM_MOUTH_L], pts[LM_MOUTH_R]),
                                      dist(pts[LM_ALA_L], pts[LM_ALA_R]), 1.5)

    # --- symmetry ---
    axis_top = midpoint(pts[LM_TRICHION], pts[LM_GLABELLA])
    axis_bottom = pts[LM_MENTON]
    out["vertical_symmetry"] = vertical_symmetry_pct(pts, axis_top, axis_bottom, face_width)
    out["horizontal_symmetry"] = horizontal_symmetry_pct(pts, axis_top, axis_bottom, face_height)

    face_height_total = dist(pts[LM_TRICHION], pts[LM_MENTON])
    out["golden_ratio"] = safe_div(face_height_total * 1.15, face_width, 1.618)
    out["face_length_ratio"] = safe_div(face_height_total, face_width, 1.42)
    eye_line_y = (eye_l_center[1] + eye_r_center[1]) / 2.0
    stomion_y = (pts[LM_UPPER_LIP_INNER][1] + pts[LM_LOWER_LIP_INNER][1]) / 2.0
    out["midface_ratio"] = safe_div(abs(stomion_y - eye_line_y), face_width, 0.50)

    eye_len_l = dist(pts[LM_EYE_L_OUTER], pts[LM_EYE_L_INNER])
    eye_len_r = dist(pts[LM_EYE_R_OUTER], pts[LM_EYE_R_INNER])
    eye_len = (eye_len_l + eye_len_r) / 2.0
    inner_gap = dist(pts[LM_EYE_L_INNER], pts[LM_EYE_R_INNER])
    out["interocular_ratio"] = safe_div(inner_gap, eye_len, 1.05)

    ax, ay = axis_top
    bx, by = axis_bottom
    dx, dy = bx - ax, by - ay
    norm = math.hypot(dx, dy)
    if norm < 1e-9:
        left_offset = abs(eye_l_center[0] - ax)
        right_offset = abs(eye_r_center[0] - ax)
    else:
        left_offset = abs((eye_l_center[0] - ax) * dy - (eye_l_center[1] - ay) * dx) / norm
        right_offset = abs((eye_r_center[0] - ax) * dy - (eye_r_center[1] - ay) * dx) / norm
    balance = safe_div(min(left_offset, right_offset), max(left_offset, right_offset), 1.0)
    out["eye_spacing_symmetry"] = clamp(100.0 * balance, 0.0, 100.0)

    # --- angularity (dynamic jaw contour analysis) ---
    jaw = jaw_contour_analysis(pts)

    gonial_l = angle_deg(pts[LM_TEMPLE_L], jaw["gonion_left"], pts[LM_MENTON])
    gonial_r = angle_deg(pts[LM_TEMPLE_R], jaw["gonion_right"], pts[LM_MENTON])
    out["gonial_angle"] = (gonial_l + gonial_r) / 2.0

    out["cheekbone_prominence"] = safe_div(face_width, temple_width, 1.2)
    out["jaw_cheek_ratio"] = safe_div(jaw["jaw_width"], face_width, 0.8)

    out["jaw_frontal_angle"] = angle_deg(jaw["gonion_left"], pts[LM_MENTON], jaw["gonion_right"])

    out["chin_width_ratio"] = safe_div(jaw["chin_width"], max(jaw["jaw_width"], 1e-6), 0.28)

    normalised_gonial = clamp((136.0 - out["gonial_angle"]) / 26.0, 0.0, 1.0)
    out["mandible_definition"] = 1.0 + normalised_gonial * 0.9 * out["jaw_cheek_ratio"]

    out["ramus_ratio"] = safe_div(jaw["ramus_height"], max(jaw["jaw_body_len"], 1e-6), 0.7)
    out["bigonial_width"] = safe_div(jaw["jaw_width"], face_height, 0.6)
    out["jaw_mass"] = safe_div(lower * jaw["jaw_width"], face_height * face_width, 0.35) * 1.55

    # chin projection is refined later when a profile photo exists
    chin_angle = angle_deg(pts[LM_SUBNASALE], pts[LM_LOWER_LIP_OUTER], pts[LM_MENTON])
    out["chin_projection"] = clamp(chin_angle, 120.0, 200.0)

    # --- dimorphism ---
    brow_gap_l = abs(pts[LM_BROW_L_TOP][1] - pts[LM_EYE_L_TOP][1])
    brow_gap_r = abs(pts[LM_BROW_R_TOP][1] - pts[LM_EYE_R_TOP][1])
    out["brow_ridge"] = safe_div((brow_gap_l + brow_gap_r) / 2.0, face_height, 0.05)

    upper_lip = abs(pts[LM_UPPER_LIP_OUTER][1] - pts[LM_UPPER_LIP_INNER][1])
    lower_lip = abs(pts[LM_LOWER_LIP_OUTER][1] - pts[LM_LOWER_LIP_INNER][1])
    mouth_width = dist(pts[LM_MOUTH_L], pts[LM_MOUTH_R])
    out["lip_thickness"] = safe_div(upper_lip + lower_lip, mouth_width, 0.36)
    out["upper_lip_ratio"] = safe_div(upper_lip, max(lower_lip, 1e-6), 0.72)

    tilt_brow_l = line_tilt_deg(pts[LM_BROW_L_INNER], pts[LM_BROW_L_OUTER])
    tilt_brow_r = line_tilt_deg(pts[LM_BROW_R_INNER], pts[LM_BROW_R_OUTER])
    out["brow_tilt"] = (tilt_brow_l + tilt_brow_r) / 2.0

    aperture_l = safe_div(dist(pts[LM_EYE_L_TOP], pts[LM_EYE_L_BOTTOM]), max(eye_len_l, 1e-6), 0.33)
    aperture_r = safe_div(dist(pts[LM_EYE_R_TOP], pts[LM_EYE_R_BOTTOM]), max(eye_len_r, 1e-6), 0.33)
    out["eye_aperture"] = (aperture_l + aperture_r) / 2.0

    cheek_span = dist(pts[LM_CHEEK_L], pts[LM_CHEEK_R])
    out["cheek_fullness"] = safe_div(face_width - cheek_span, face_width, 0.25) * 1.1
    out["chin_height_ratio"] = safe_div(abs(menton_y - pts[LM_LOWER_LIP_OUTER][1]), lower, 0.3)

    # --- features ---
    out["eye_size"] = safe_div(eye_len, face_width, 0.23)
    nose_width_px = dist(pts[LM_ALA_L], pts[LM_ALA_R])
    out["nose_width"] = safe_div(nose_width_px, face_width, 0.26)
    out["lip_width"] = safe_div(mouth_width, face_width, 0.39)
    nose_length_px = dist(pts[LM_NASION], pts[LM_SUBNASALE])
    out["nose_length"] = safe_div(nose_length_px, face_width, 0.43)
    out["nasal_index"] = safe_div(nose_width_px, max(nose_length_px, 1e-6), 0.66)
    out["philtrum_length"] = safe_div(abs(pts[LM_UPPER_LIP_OUTER][1] - subnasale_y),
                                     face_height, 0.07)
    out["nose_height_ratio"] = safe_div(nose_length_px, face_height, 0.34)
    out["mouth_width_ratio"] = safe_div(mouth_width, max(pupil_distance, 1e-6), 1.5)

    out["_face_width"] = face_width
    out["_face_height"] = face_height
    out["_jaw_width"] = jaw["jaw_width"]
    out["_pupil_distance"] = pupil_distance
    out["_brow_line_y"] = brow_line_y
    out["_trichion_y"] = trichion_y
    out["_menton_y"] = menton_y
    return out


def vertical_symmetry_pct(pts: List[Tuple[float, float]], axis_top: Sequence[float],
                          axis_bottom: Sequence[float], face_width: float) -> float:
    """Compare mirrored distances of paired landmarks from the facial midline."""
    ax, ay = axis_top
    bx, by = axis_bottom
    dx, dy = bx - ax, by - ay
    norm = math.hypot(dx, dy)
    if norm < 1e-9:
        return 100.0
    deviations: List[float] = []
    for left_idx, right_idx in SYMMETRY_PAIRS:
        lp, rp = pts[left_idx], pts[right_idx]
        d_left = ((lp[0] - ax) * dy - (lp[1] - ay) * dx) / norm
        d_right = ((rp[0] - ax) * dy - (rp[1] - ay) * dx) / norm
        deviations.append(abs(abs(d_left) - abs(d_right)))
    mean_dev = sum(deviations) / len(deviations)
    return clamp(100.0 - (mean_dev / max(face_width, 1e-6)) * 420.0, 0.0, 100.0)


def horizontal_symmetry_pct(pts: List[Tuple[float, float]], axis_top: Sequence[float],
                            axis_bottom: Sequence[float], face_height: float) -> float:
    """Compare the position of paired landmarks along the facial midline axis.

    Projecting onto the midline direction makes horizontal symmetry invariant
    to natural head roll (tilt) in the camera frame.
    """
    ax, ay = axis_top
    bx, by = axis_bottom
    dx, dy = bx - ax, by - ay
    norm = math.hypot(dx, dy)
    if norm < 1e-9:
        ux, uy = 0.0, 1.0
    else:
        ux, uy = dx / norm, dy / norm

    deviations = [abs((pts[l][0] - pts[r][0]) * ux + (pts[l][1] - pts[r][1]) * uy)
                  for l, r in SYMMETRY_PAIRS]
    mean_dev = sum(deviations) / len(deviations)
    return clamp(100.0 - (mean_dev / max(face_height, 1e-6)) * 480.0, 0.0, 100.0)


def profile_metrics(pts: List[Tuple[float, float]]) -> Dict[str, float]:
    """Refine projection-sensitive measurements using the profile photo."""
    out: Dict[str, float] = {}
    # Facial convexity angle glabella-subnasale-menton. A straighter profile means
    # a stronger chin, so projection is read as its complement around 333 degrees.
    facial_convexity = angle_deg(pts[LM_GLABELLA], pts[LM_SUBNASALE], pts[LM_MENTON])
    if facial_convexity <= 1.0:
        out["chin_projection"] = 168.0
    else:
        out["chin_projection"] = clamp(333.0 - facial_convexity, 120.0, 200.0)
    out["facial_convexity"] = facial_convexity
    jaw_p = jaw_contour_analysis(pts)
    gonial_l = angle_deg(pts[LM_TEMPLE_L], jaw_p["gonion_left"], pts[LM_MENTON])
    gonial_r = angle_deg(pts[LM_TEMPLE_R], jaw_p["gonion_right"], pts[LM_MENTON])
    out["gonial_angle"] = (gonial_l + gonial_r) / 2.0
    out["ramus_ratio"] = safe_div(jaw_p["ramus_height"], max(jaw_p["jaw_body_len"], 1e-6), 0.7)
    out["mandible_definition"] = 1.0 + clamp((136.0 - out["gonial_angle"]) / 26.0, 0.0, 1.0) * 0.9 * 0.75
    return out


# ---------------------------------------------------------------------------
# Pixel analysis: skin + hair
# ---------------------------------------------------------------------------

def face_mask(image: np.ndarray, pts: List[Tuple[float, float]]) -> np.ndarray:
    """Filled polygon over the face oval."""
    height, width = image.shape[:2]
    mask = np.zeros((height, width), dtype=np.uint8)
    polygon = np.array([[int(pts[i][0]), int(pts[i][1])] for i in FACE_OVAL_IDX], dtype=np.int32)
    cv2.fillConvexPoly(mask, cv2.convexHull(polygon), 255)
    return mask


def patch_mean_lab(lab: np.ndarray, center: Sequence[float], radius: int) -> Tuple[float, float, float]:
    """Mean L, a, b inside a square patch clipped to the image."""
    height, width = lab.shape[:2]
    cx, cy = int(center[0]), int(center[1])
    x0 = max(0, cx - radius)
    x1 = min(width, cx + radius + 1)
    y0 = max(0, cy - radius)
    y1 = min(height, cy + radius + 1)
    if x1 <= x0 or y1 <= y0:
        return 60.0, 12.0, 16.0
    patch = lab[y0:y1, x0:x1].reshape(-1, 3).astype(np.float32)
    mean = patch.mean(axis=0)
    return (float(mean[0] * 100.0 / 255.0), float(mean[1] - 128.0), float(mean[2] - 128.0))


def skin_metrics(image: np.ndarray, pts: List[Tuple[float, float]]) -> Dict[str, float]:
    """Colour and texture statistics sampled from skin regions."""
    out: Dict[str, float] = {}
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    mask = face_mask(image, pts)

    face_width = dist(pts[LM_ZYGO_L], pts[LM_ZYGO_R])
    radius = max(4, int(face_width * 0.045))

    sample_points = [
        pts[LM_CHEEK_L], pts[LM_CHEEK_R], pts[LM_FOREHEAD_MID],
        pts[LM_GLABELLA], pts[LM_JAW_L_MID], pts[LM_JAW_R_MID],
    ]
    samples = [patch_mean_lab(lab, p, radius) for p in sample_points]
    lightness = [s[0] for s in samples]
    a_values = [s[1] for s in samples]
    b_values = [s[2] for s in samples]

    mean_l = sum(lightness) / len(lightness)
    mean_a = sum(a_values) / len(a_values)
    mean_b = sum(b_values) / len(b_values)

    # Individual Typology Angle: atan((L* - 50) / b*) in degrees.
    if abs(mean_b) < 1e-6:
        out["skin_tone_ita"] = 30.0
    else:
        out["skin_tone_ita"] = math.degrees(math.atan2(mean_l - 50.0, mean_b))

    spread_l = float(np.std(np.array(lightness, dtype=np.float32)))
    out["skin_evenness"] = clamp(100.0 - spread_l * 5.2, 0.0, 100.0)
    out["skin_redness"] = mean_a

    face_pixels = gray[mask > 0]
    if face_pixels.size < 64:
        out["skin_clarity"] = 80.0
        out["skin_texture"] = 28.0
        out["skin_shine"] = 2.0
        out["skin_contrast"] = 7.0
    else:
        blurred = cv2.GaussianBlur(gray, (0, 0), sigmaX=max(1.2, face_width * 0.012))
        high_freq = cv2.absdiff(gray, blurred)
        hf_face = high_freq[mask > 0].astype(np.float32)
        texture = float(hf_face.mean()) * 6.0
        out["skin_texture"] = clamp(texture, 0.0, 100.0)
        blemish_ratio = float((hf_face > 14.0).mean())
        out["skin_clarity"] = clamp(100.0 - blemish_ratio * 260.0, 0.0, 100.0)
        shine_ratio = float((face_pixels > 240).mean())
        out["skin_shine"] = clamp(shine_ratio * 100.0, 0.0, 100.0)
        out["skin_contrast"] = clamp(float(np.std(face_pixels.astype(np.float32))) * 0.35,
                                    0.0, 60.0)

    cheek_l = patch_mean_lab(lab, pts[LM_CHEEK_L], radius)[0]
    cheek_r = patch_mean_lab(lab, pts[LM_CHEEK_R], radius)[0]
    under_l = patch_mean_lab(lab, pts[LM_UNDEREYE_L], max(3, radius // 2))[0]
    under_r = patch_mean_lab(lab, pts[LM_UNDEREYE_R], max(3, radius // 2))[0]
    cheek_mean = (cheek_l + cheek_r) / 2.0
    under_mean = (under_l + under_r) / 2.0
    out["undereye_darkness"] = clamp(cheek_mean - under_mean, 0.0, 40.0)

    out["_mean_l"] = mean_l
    out["_mean_a"] = mean_a
    out["_mean_b"] = mean_b
    return out


def hair_metrics(image: np.ndarray, pts: List[Tuple[float, float]]) -> Dict[str, float]:
    """Statistics for the band above the hairline plus the two temple columns."""
    out: Dict[str, float] = {}
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)

    trichion_y = pts[LM_TRICHION][1]
    face_height = dist(pts[LM_TRICHION], pts[LM_MENTON])
    face_width = dist(pts[LM_ZYGO_L], pts[LM_ZYGO_R])

    band_height = max(8, int(face_height * 0.34))
    y1 = int(clamp(trichion_y, 0, height - 1))
    y0 = int(clamp(trichion_y - band_height, 0, height - 1))
    x0 = int(clamp(pts[LM_TEMPLE_L][0] - face_width * 0.06, 0, width - 1))
    x1 = int(clamp(pts[LM_TEMPLE_R][0] + face_width * 0.06, 0, width - 1))

    # Hairline height as a share of face height, measured from the frame top.
    out["hairline_height"] = clamp(100.0 * safe_div(max(trichion_y, 0.0), max(face_height, 1e-6), 0.15)
                                  * 0.5, 0.0, 60.0)

    if y1 - y0 < 6 or x1 - x0 < 6:
        out["hair_coverage"] = 55.0
        out["hair_density"] = 60.0
        out["hair_shine"] = 8.0
        out["hair_darkness"] = 55.0
        out["hair_uniformity"] = 72.0
        out["_hair_band"] = 0.0
        return out

    band_gray = gray[y0:y1, x0:x1].astype(np.float32)
    band_hsv = hsv[y0:y1, x0:x1]
    band_val = band_hsv[:, :, 2].astype(np.float32)
    band_sat = band_hsv[:, :, 1].astype(np.float32)

    skin_reference = patch_mean_lab(cv2.cvtColor(image, cv2.COLOR_BGR2LAB),
                                   pts[LM_FOREHEAD_MID], max(4, int(face_width * 0.04)))[0]
    skin_gray_ref = skin_reference * 255.0 / 100.0

    # Pixels notably darker or more saturated than forehead skin count as hair.
    hair_pixels = (band_gray < max(30.0, skin_gray_ref - 26.0)) | (band_sat > 140.0)
    coverage = float(hair_pixels.mean())
    out["hair_coverage"] = clamp(coverage * 118.0, 0.0, 100.0)

    if hair_pixels.sum() < 40:
        out["hair_density"] = clamp(coverage * 110.0, 0.0, 100.0)
        out["hair_darkness"] = 50.0
        out["hair_shine"] = 6.0
        out["hair_uniformity"] = 70.0
        out["_hair_band"] = float(hair_pixels.sum())
        return out

    hair_vals = band_val[hair_pixels]
    out["hair_darkness"] = clamp(100.0 - float(hair_vals.mean()) * 100.0 / 255.0, 0.0, 100.0)
    out["hair_density"] = clamp(coverage * 92.0 + (out["hair_darkness"] * 0.26), 0.0, 100.0)
    out["hair_shine"] = clamp(float((hair_vals > 190.0).mean()) * 100.0, 0.0, 100.0)
    out["hair_uniformity"] = clamp(100.0 - float(np.std(hair_vals)) * 0.85, 0.0, 100.0)
    out["_hair_band"] = float(hair_pixels.sum())
    return out


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def dimorphism_index(raw: Dict[str, float], gender: str,
                     bands: Dict[str, Tuple[float, float]]) -> float:
    """Composite masculinity/femininity alignment, expressed 0..100."""
    contributors = ("brow_ridge", "lip_thickness", "jaw_mass", "eye_aperture",
                    "cheek_fullness", "brow_tilt", "gonial_angle")
    scores: List[float] = []
    for key in contributors:
        if key not in raw or key not in bands:
            continue
        lo, hi = bands[key]
        scores.append(gaussian_score(raw[key], lo, hi))
    if not scores:
        return 70.0
    return clamp(sum(scores) / len(scores) * 10.0, 0.0, 100.0)


def category_summary(cat: str, metrics: List[Dict[str, Any]]) -> Dict[str, Any]:
    meta = CATEGORY_META[cat]
    if metrics:
        avg = sum(m["score"] for m in metrics) / len(metrics)
    else:
        avg = 0.0
    avg = round(avg, 2)
    ordered = sorted(metrics, key=lambda m: m["score"], reverse=True)
    return {
        "key": cat,
        "title": meta["title"],
        "title_ru": meta["title_ru"],
        "icon": meta["icon"],
        "weight": meta["weight"],
        "score": avg,
        "color": score_color(avg),
        "rating_ru": score_label_ru(avg),
        "percentile": percentile_from_score(avg),
        "metric_count": len(metrics),
        "metrics": metrics,
        "strengths": [
            {"key": m["key"], "label": m["label"], "score": m["score"],
             "display": m["display"], "rating_ru": m["rating_ru"],
             "advice_ru": m.get("advice_ru", "")}
            for m in ordered[:2] if m["score"] >= 6.0
        ],
        "improvements": [
            {"key": m["key"], "label": m["label"], "score": m["score"],
             "display": m["display"], "direction_ru": m["direction_ru"],
             "advice_ru": m.get("advice_ru", "")}
            for m in list(reversed(ordered))[:2] if m["score"] < 7.0
        ],
    }


def build_gaussian_chart(overall: float) -> Dict[str, Any]:
    """Population curve plus the user's position, for the results chart."""
    mu, sigma = 5.5, 1.55
    points: List[Dict[str, float]] = []
    step = 0.25
    x = 0.0
    while x <= 10.0 + 1e-9:
        y = math.exp(-((x - mu) ** 2) / (2.0 * sigma * sigma))
        points.append({"x": round(x, 2), "y": round(y, 4)})
        x += step
    return {
        "mu": mu,
        "sigma": sigma,
        "points": points,
        "user_x": round(overall, 2),
        "user_y": round(math.exp(-((overall - mu) ** 2) / (2.0 * sigma * sigma)), 4),
        "percentile": percentile_from_score(overall),
    }


def build_looksmaxxing_summary(raw: Dict[str, float], overall_score: float, gender: str) -> Dict[str, Any]:
    """Generates structured Looksmaxxing assessment, PSL score, archetypes, and actionable protocols."""
    canthal = raw.get("canthal_tilt", 0.0)
    gonial = raw.get("gonial_angle", 124.0)
    chin_proj = raw.get("chin_projection", 165.0)
    cheek = raw.get("cheek_fullness", 50.0)
    mandible = raw.get("mandible_definition", 1.3)

    # Eye archetype (Hunter vs Prey)
    if canthal >= 3.0:
        eye_archetype = {
            "name": "Hunter Eyes",
            "tier": "S-Tier",
            "badge": "🟢 Hunter Eyes (Положительный тилт)",
            "desc": f"Положительный угол наклона глаз (+{round(canthal, 1)}°). Хищный модельный взгляд, минимальное обнажение склеры.",
            "status": "optimal",
        }
    elif canthal >= 0.0:
        eye_archetype = {
            "name": "Neutral Eyes",
            "tier": "A-Tier",
            "badge": "🟡 Neutral Eyes (Сбалансированный тилт)",
            "desc": f"Нейтральный угол ({round(canthal, 1)}°). Сбалансированный разрез без выраженной агрессии или утомлённости.",
            "status": "normal",
        }
    else:
        eye_archetype = {
            "name": "Prey Eyes",
            "tier": "C-Tier",
            "badge": "🔴 Prey Eyes (Отрицательный тилт)",
            "desc": f"Отрицательный угол ({round(canthal, 1)}°). Внешние углы опущены, создают усталый/грустный взгляд. Требует проработки век.",
            "status": "flawed",
        }

    # Jaw archetype (Chad Jaw vs High Gonial)
    if gonial <= 120.0 and mandible >= 1.4:
        jaw_archetype = {
            "name": "Chad Jawline",
            "tier": "S-Tier",
            "badge": "🟢 Chad Jawline (Острый угол 110-120°)",
            "desc": f"Гониальный угол {round(gonial, 1)}°. Идеальная резкая линия нижней челюсти, выраженные жевательные мышцы.",
            "status": "optimal",
        }
    elif gonial <= 126.0:
        jaw_archetype = {
            "name": "Defined Jaw",
            "tier": "B-Tier",
            "badge": "🟡 Defined Jaw (Нормальная резкость)",
            "desc": f"Гониальный угол {round(gonial, 1)}°. Хороший контур, но можно улучшить чёткость снижением подкожного жира.",
            "status": "normal",
        }
    else:
        jaw_archetype = {
            "name": "High Gonial / Soft Jaw",
            "tier": "C-Tier",
            "badge": "🔴 Soft Jaw (>126° размытый угол)",
            "desc": f"Гониальный угол {round(gonial, 1)}°. Линия челюсти сглажена, слабая костная опора. Нужен мьюинг и жевание мастики.",
            "status": "flawed",
        }

    # Chin projection (Forward grown vs Recessed)
    if chin_proj >= 165.0:
        chin_archetype = {
            "name": "Forward Grown",
            "tier": "S-Tier",
            "badge": "🟢 Forward Grown (Развитый подбородок)",
            "desc": "Отличная фронтальная проекция подбородка, правильное развитие максиллы и нижней челюсти.",
            "status": "optimal",
        }
    else:
        chin_archetype = {
            "name": "Recessed Chin",
            "tier": "C-Tier",
            "badge": "🔴 Recessed Chin (Рецессия подбородка)",
            "desc": "Подбородок смещён назад относительно вертикали губ. Характерно при ротовом дыхании в детстве.",
            "status": "flawed",
        }

    # Cheeks (Hollow vs Bloated)
    if cheek <= 44.0:
        cheek_archetype = {
            "name": "Hollow Cheeks",
            "tier": "S-Tier",
            "badge": "🟢 Hollow Cheeks (Впалые скулы)",
            "desc": "Минимальный объём щёчного жира, выраженная тень под скулами — классический подиумный признак.",
            "status": "optimal",
        }
    else:
        cheek_archetype = {
            "name": "Bloated / High Buccal Fat",
            "tier": "B-Tier",
            "badge": "🟡 Bloated / Округлость",
            "desc": "Отёчность или повышенный процент жира скрывает скуловую кость. Необходим деблоатинг.",
            "status": "normal",
        }

    # PSL score (1.0 .. 8.0 scale popular in looksmaxxing)
    psl_score = round(max(1.0, min(8.0, overall_score * 0.78)), 1)
    potential_score = round(min(9.7, overall_score + 1.6 + (1.0 if overall_score < 5.5 else 0.4)), 1)

    # Actionable Softmaxxing protocol
    softmaxxing = [
        {"title": "Деблоатинг (Debloating)", "action": "Снизьте потребление натрия (<1500 мг), исключите сахар и быстрые углеводы. Пейте 2.5-3 л чистой воды ежедневно + калий (бананы, шпинат), чтобы согнать воду с лица."},
        {"title": "Мьюинг (Mewing)", "action": "Держите всё тело языка прижатым к нёбу (включая заднюю треть) 24/7. Зубы слегка сомкнуты, губы закрыты, дыхание строго через нос."},
        {"title": "Сушка (10-12% Body Fat)", "action": "Снижение общего процента жира в теле до 10-12% (для мужчин) обнажит скрытую костную структуру скул и углов челюсти."},
        {"title": "Тренировка жевательных мышц", "action": "Жевание твёрдой смолы (мастика Falim/Mastic gum) по 20-30 минут в день для гипертрофии masseter и расширения нижней трети лица."},
        {"title": "Коррекция осанки (Neck Posture)", "action": "Устраните наклон головы вперёд ('текстовая шея'). Прямая шея визуально натягивает кожу под подбородком и увеличивает проекцию."},
        {"title": "Скинкеар протокол", "action": "SPF 50+ каждое утро, ретинол 0.05% вечером 3 раза в неделю, крем с керамидами для плотности кожного барьера."},
    ]

    # Hardmaxxing considerations
    hardmaxxing = []
    if canthal < 0.0:
        hardmaxxing.append("Кантопексия / Кантопластика — хирургический подъём наружного угла глаза при стойком отрицательном наклоне.")
    if gonial > 126.0:
        hardmaxxing.append("Импланты углов нижней челюсти (Jaw angle implants) или моделирование плотным филлером Radiesse/гиалуроном.")
    if chin_proj < 165.0:
        hardmaxxing.append("Скользящая гениопластика (Sliding genioplasty) или ментопластика имплантом для выдвижения подбородка вперёд.")
    if cheek > 50.0:
        hardmaxxing.append("Удаление комков Биша (Buccal fat removal) при генетически круглом лице без лишнего веса.")
    if not hardmaxxing:
        hardmaxxing.append("Костный скелет гармоничен. Хирургические вмешательства не требуются, сосредоточьтесь на Softmaxxing.")

    return {
        "psl_score": psl_score,
        "overall_score": overall_score,
        "potential_score": potential_score,
        "tier": score_label_ru(overall_score),
        "archetypes": {
            "eyes": eye_archetype,
            "jaw": jaw_archetype,
            "chin": chin_archetype,
            "cheeks": cheek_archetype,
        },
        "softmaxxing": softmaxxing,
        "hardmaxxing": hardmaxxing,
    }


def analyse(front_image: np.ndarray, profile_image: Optional[np.ndarray],
            gender: str, ethnicity: str) -> Dict[str, Any]:
    """Full pipeline for one submission."""
    started = time.time()
    bands = build_bands(gender, ethnicity)

    front_pts, blendshapes = detect_landmarks(front_image)
    raw = frontal_metrics(front_pts)
    raw.update(skin_metrics(front_image, front_pts))
    raw.update(hair_metrics(front_image, front_pts))

    sources: Dict[str, str] = {key: "front" for key in raw}
    profile_used = False
    profile_landmarks: List[Tuple[float, float]] = []
    if profile_image is not None:
        try:
            profile_pts, _ = detect_landmarks(profile_image)
            profile_raw = profile_metrics(profile_pts)
            for k in ("chin_projection", "gonial_angle", "ramus_ratio", "mandible_definition"):
                if k in profile_raw:
                    raw[k] = profile_raw[k]
                    sources[k] = "profile"
            profile_landmarks = profile_pts
            profile_used = True
        except Exception as err:
            # A bad profile shot must never fail the whole analysis.
            print(f"[face-lab] profile processing skipped: {err}", file=sys.stderr)
            profile_used = False

    raw["dimorphism_index"] = dimorphism_index(raw, gender, bands)

    metrics_flat: Dict[str, Dict[str, Any]] = {}
    for definition in METRIC_DEFS:
        key = definition["key"]
        value = raw.get(key)
        if value is None:
            continue
        metrics_flat[key] = build_metric_result(key, float(value), bands,
                                                sources.get(key, "front"))

    categories: List[Dict[str, Any]] = []
    for cat in CATEGORY_ORDER:
        cat_metrics = [metrics_flat[k] for k in METRICS_BY_CAT[cat] if k in metrics_flat]
        categories.append(category_summary(cat, cat_metrics))

    weight_total = sum(CATEGORY_META[c["key"]]["weight"] for c in categories if c["metric_count"])
    weighted = sum(c["score"] * CATEGORY_META[c["key"]]["weight"]
                   for c in categories if c["metric_count"])
    overall = round(safe_div(weighted, weight_total, 0.0), 2)

    all_metrics = list(metrics_flat.values())
    ranked = sorted(all_metrics, key=lambda m: m["score"], reverse=True)

    front_h, front_w = front_image.shape[:2]
    looksmaxxing = build_looksmaxxing_summary(raw, overall, gender)

    return {
        "ok": True,
        "version": "1.0",
        "generated_at": int(time.time()),
        "elapsed_ms": int((time.time() - started) * 1000),
        "gender": gender,
        "ethnicity": ethnicity,
        "profile_used": profile_used,
        "landmark_count": len(front_pts),
        "profile_landmark_count": len(profile_landmarks),
        "overall": {
            "score": overall,
            "color": score_color(overall),
            "rating_ru": score_label_ru(overall),
            "percentile": percentile_from_score(overall),
            "metric_count": len(all_metrics),
        },
        "looksmaxxing": looksmaxxing,
        "categories": categories,
        "category_order": CATEGORY_ORDER,
        "metrics": metrics_flat,
        "top_strengths": [
            {"key": m["key"], "label": m["label"], "score": m["score"],
             "display": m["display"], "category": m["category"]}
            for m in ranked[:3]
        ],
        "top_improvements": [
            {"key": m["key"], "label": m["label"], "score": m["score"],
             "display": m["display"], "category": m["category"],
             "direction_ru": m["direction_ru"], "advice_ru": m.get("advice_ru", "")}
            for m in list(reversed(ranked))[:3]
        ],
        "chart": build_gaussian_chart(overall),
        "image": {
            "front_width": front_w,
            "front_height": front_h,
            "face_width_px": round(raw.get("_face_width", 0.0), 1),
            "face_height_px": round(raw.get("_face_height", 0.0), 1),
        },
        "landmarks": {
            "front": [[round(p[0] / max(front_w, 1), 5), round(p[1] / max(front_h, 1), 5)]
                      for p in front_pts],
        },
        "blendshape_sample": dict(sorted(blendshapes.items(),
                                         key=lambda kv: kv[1], reverse=True)[:8]),
        "standards_used": {k: [round(v[0], 4), round(v[1], 4)] for k, v in bands.items()
                          if k in METRIC_BY_KEY},
    }


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Fetch the model bundle before serving and warm up detector."""
    try:
        ensure_model()
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, get_detector)
    except Exception as error:  # noqa: BLE001 - keep serving static pages
        print(f"[face-lab] model warmup deferred: {error}", file=sys.stderr)
    yield


app = FastAPI(title="FACE LAB", version="1.0",
              description="Facial analysis service based on MediaPipe FaceLandmarker.",
              lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

ALLOWED_ANALYSIS_PAGES = {
    "harmony.html", "angularity.html", "dimorphism.html",
    "features.html", "skin.html", "hair.html",
}
ALLOWED_DETAIL_PAGES = {
    "harmony-detail.html", "angularity-detail.html", "dimorphism-detail.html",
    "features-detail.html", "skin-detail.html", "hair-detail.html",
}


def send_static(*relative: str) -> FileResponse:
    path = os.path.join(STATIC_DIR, *relative)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Файл не найден.")
    return FileResponse(path)


@app.get("/", response_class=HTMLResponse)
def index() -> FileResponse:
    return send_static("index.html")


@app.get("/style.css")
def style_css() -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "style.css"), media_type="text/css")


@app.get("/script.js")
def script_js() -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "script.js"),
                        media_type="application/javascript")


@app.get("/shared.js")
def shared_js() -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "shared.js"),
                        media_type="application/javascript")


@app.get("/analysis-page.js")
def analysis_page_js() -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "analysis-page.js"),
                        media_type="application/javascript")


@app.get("/detail-page.js")
def detail_page_js() -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "detail-page.js"),
                        media_type="application/javascript")


@app.get("/analysis/{page}", response_class=HTMLResponse)
def analysis_page(page: str) -> FileResponse:
    if page not in ALLOWED_ANALYSIS_PAGES:
        raise HTTPException(status_code=404, detail="Страница не найдена.")
    return send_static("analysis", page)


@app.get("/details/{page}", response_class=HTMLResponse)
def detail_page(page: str) -> FileResponse:
    if page not in ALLOWED_DETAIL_PAGES:
        raise HTTPException(status_code=404, detail="Страница не найдена.")
    return send_static("details", page)


@app.get("/api/standards")
def api_standards() -> JSONResponse:
    """Expose the reference bands so the UI can render scales without a re-analysis."""
    payload = {
        "genders": list(GENDERS),
        "ethnicities": list(ETHNICITIES),
        "categories": {
            cat: {
                "title": CATEGORY_META[cat]["title"],
                "title_ru": CATEGORY_META[cat]["title_ru"],
                "weight": CATEGORY_META[cat]["weight"],
                "metrics": METRICS_BY_CAT[cat],
            }
            for cat in CATEGORY_ORDER
        },
        "metrics": {
            m["key"]: {"label": m["label"], "unit": m["unit"],
                       "category": m["cat"], "description_ru": m["ru"]}
            for m in METRIC_DEFS
        },
        "standards": {
            f"{gender}:{ethnicity}": {k: [v[0], v[1]]
                                      for k, v in build_bands(gender, ethnicity).items()}
            for gender in GENDERS for ethnicity in ETHNICITIES
        },
    }
    return JSONResponse(payload)


@app.get("/api/health")
def api_health() -> JSONResponse:
    return JSONResponse({
        "ok": True,
        "model_present": os.path.isfile(MODEL_PATH),
        "detector_ready": _detector is not None,
        "metric_count": len(METRIC_DEFS),
        "category_count": len(CATEGORY_ORDER),
        "standard_count": len(STANDARDS),
    })


def normalise_choice(value: str, allowed: Sequence[str], field: str) -> str:
    cleaned = (value or "").strip().lower().replace(" ", "_").replace("-", "_")
    if not cleaned:
        return "male" if field == "gender" else "caucasian"
    if cleaned not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Некорректное значение поля {field}. Допустимо: {', '.join(allowed)}.",
        )
    return cleaned


@app.post("/analyze-complete")
async def analyze_complete(
    front: UploadFile = File(...),
    profile: Optional[UploadFile] = File(None),
    gender: str = Form(...),
    ethnicity: str = Form(...),
    initData: str = Form(""),
) -> JSONResponse:
    """Main entry point: front photo required, profile optional."""
    gender_value = normalise_choice(gender, GENDERS, "gender")
    ethnicity_value = normalise_choice(ethnicity, ETHNICITIES, "ethnicity")

    # --- Telegram WebApp access check ---
    user_id = 0
    if initData:
        from bot import verify_init_data, BOT_TOKEN
        import database as db

        if not verify_init_data(initData, BOT_TOKEN):
            raise HTTPException(status_code=403, detail="Недействительные данные авторизации Telegram.")

        import urllib.parse
        params = dict(urllib.parse.parse_qsl(initData))
        user_data = json.loads(params.get("user", "{}"))
        user_id = int(user_data.get("id", 0))

        if user_id and not db.can_analyse(user_id):
            raise HTTPException(
                status_code=402,
                detail="Для анализа нужно купить пакет анализов в боте @FaceLabs_bot. Стоимость — от 50₽ (по цене батончика 🍫).",
            )

    front_bytes = await front.read()
    front_image = decode_upload(front_bytes)

    profile_image: Optional[np.ndarray] = None
    if profile is not None and getattr(profile, "filename", ""):
        profile_bytes = await profile.read()
        if profile_bytes:
            profile_image = decode_upload(profile_bytes)

    try:
        result = analyse(front_image, profile_image, gender_value, ethnicity_value)
    except HTTPException:
        raise
    except Exception as error:  # noqa: BLE001 - surface a readable message to the UI
        print(f"[face-lab] analysis failed: {type(error).__name__}: {error}", file=sys.stderr)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Ошибка анализа изображения: {error}") from error

    # --- Consume paid credit if not subscribed ---
    if user_id:
        import database as db
        if not db.is_subscribed(user_id):
            db.consume_analysis_credit(user_id)
        db.add_analysis(user_id, result.get("overall", {}).get("score", 0),
                        gender_value, ethnicity_value)

    return JSONResponse(result)


# ---------------------------------------------------------------------------
# Telegram WebApp API
# ---------------------------------------------------------------------------

@app.post("/api/telegram/verify")
async def telegram_verify(initData: str = Form(...)) -> JSONResponse:
    """Verify Telegram WebApp initData and return user info + access status."""
    from bot import verify_init_data, BOT_TOKEN
    import database as db

    if not verify_init_data(initData, BOT_TOKEN):
        raise HTTPException(status_code=403, detail="Invalid Telegram initData")

    import urllib.parse
    params = dict(urllib.parse.parse_qsl(initData))
    user_data = json.loads(params.get("user", "{}"))
    user_id = int(user_data.get("id", 0))

    if not user_id:
        raise HTTPException(status_code=400, detail="No user ID in initData")

    db.upsert_user(user_id, user_data.get("username", ""), user_data.get("first_name", ""))

    return JSONResponse({
        "ok": True,
        "user_id": user_id,
        "username": user_data.get("username", ""),
        "first_name": user_data.get("first_name", ""),
        "can_analyse": db.can_analyse(user_id),
        "has_free": db.has_free_analysis(user_id),
        "is_subscribed": db.is_subscribed(user_id),
        "subscription": db.get_subscription_info(user_id),
    })


@app.post("/api/telegram/analysis-used")
async def telegram_analysis_used(user_id: int = Form(...)) -> JSONResponse:
    """Mark that a free analysis was consumed."""
    import database as db
    db.add_analysis(user_id, 0.0, "", "")
    return JSONResponse({"ok": True})


@app.post("/api/telegram/analysis-result")
async def telegram_analysis_result(
    user_id: int = Form(...),
    overall: float = Form(...),
    gender: str = Form(""),
    ethnicity: str = Form(""),
) -> JSONResponse:
    """Save analysis result after completion."""
    import database as db
    db.add_analysis(user_id, overall, gender, ethnicity)
    return JSONResponse({"ok": True})


# ---------------------------------------------------------------------------
# Gemini AI FaceGPT endpoint
# ---------------------------------------------------------------------------

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")


class ChatMessage(BaseModel):
    role: str = "user"
    text: str


class ChatRequest(BaseModel):
    message: str
    context: Optional[Dict[str, Any]] = None
    image: Optional[str] = None
    history: Optional[List[ChatMessage]] = None


@app.post("/api/chat")
async def api_chat(req: ChatRequest) -> JSONResponse:
    """Chat with FaceGPT powered by Google Gemini 3.6 Flash."""
    user_msg = req.message.strip()
    if not user_msg:
        raise HTTPException(status_code=400, detail="Пустое сообщение.")

    system_prompt = (
        "Ты — FaceGPT, ведущий ИИ-эстетист, антропометрист и эксперт по гармонии лица FaceIQ Labs. "
        "Ты анализируешь черты лица, пропорции, углы и состояние кожи. "
        "Твоя задача — давать профессиональные, научно обоснованные, тактичные и практичные рекомендации "
        "по гармонизации лица, уходу за кожей, прическам, осанке и эстетическому развитию (lookmaxxing). "
        "Отвечай на чистом, грамотном русском языке. "
        "Используй форматирование markdown: четкие списки, жирный шрифт для ключевых терминов, абзацы. "
        "Будь вдохновляющим, конструктивным и точным."
    )

    context_text = ""
    if req.context:
        ctx = req.context
        overall = ctx.get("overall_score")
        strengths = ctx.get("strengths", [])
        improvements = ctx.get("improvements", [])
        gender = ctx.get("gender", "не указан")
        ethnicity = ctx.get("ethnicity", "не указан")
        metrics_summary = ctx.get("metrics_summary", "")

        context_text = (
            f"\n\n[ДАННЫЕ АНАЛИЗА ПОЛЬЗОВАТЕЛЯ]:\n"
            f"- Общий балл гармонии: {overall}/10\n"
            f"- Пол: {gender}, Тип внешности: {ethnicity}\n"
        )
        if strengths:
            context_text += f"- Сильные стороны (топ): {', '.join(strengths[:5])}\n"
        if improvements:
            context_text += f"- Зоны роста (топ): {', '.join(improvements[:5])}\n"
        if metrics_summary:
            context_text += f"- Ключевые метрики:\n{metrics_summary}\n"

    parts: List[Dict[str, Any]] = []

    if req.image and "base64," in req.image:
        try:
            header, b64data = req.image.split("base64,", 1)
            mime_type = "image/jpeg"
            if "png" in header:
                mime_type = "image/png"
            elif "webp" in header:
                mime_type = "image/webp"
            parts.append({
                "inlineData": {
                    "mimeType": mime_type,
                    "data": b64data.strip()
                }
            })
        except Exception:
            pass

    full_prompt = f"{system_prompt}{context_text}\n\nПользователь спрашивает: {user_msg}"
    parts.append({"text": full_prompt})

    contents: List[Dict[str, Any]] = []
    if req.history:
        for hist in req.history[-6:]:
            role = "user" if hist.role == "user" else "model"
            contents.append({
                "role": role,
                "parts": [{"text": hist.text}]
            })

    contents.append({
        "role": "user",
        "parts": parts
    })

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    gemini_payload = {
        "contents": contents,
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 1024,
        }
    }

    try:
        data_bytes = json.dumps(gemini_payload).encode("utf-8")
        req_obj = urllib.request.Request(
            url,
            data=data_bytes,
            headers={"Content-Type": "application/json"}
        )
        loop = asyncio.get_event_loop()
        resp_data = await loop.run_in_executor(None, lambda: urllib.request.urlopen(req_obj, timeout=35).read())
        res = json.loads(resp_data.decode("utf-8"))
        answer = res["candidates"][0]["content"]["parts"][0]["text"]
        return JSONResponse({
            "ok": True,
            "reply": answer,
            "model": GEMINI_MODEL
        })
    except Exception as e:
        print(f"[FaceGPT] Error calling Gemini: {e}")
        fallback_reply = (
            "**FaceGPT:** Пропорции вашего лица показывают отличный потенциал! "
            "С учетом ваших сильных сторон рекомендуем делать упор на подчеркивание контура челюсти "
            "и правильный уход за кожей."
        )
        return JSONResponse({
            "ok": True,
            "reply": fallback_reply,
            "model": "fallback"
        })


# ---------------------------------------------------------------------------
# Bot startup (background thread)
# ---------------------------------------------------------------------------

_bot_thread = None

def _start_bot_background():
    """Start Telegram bot polling in a background thread."""
    global _bot_thread
    import threading
    import asyncio

    def _run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            from bot import create_bot
            bot_app = create_bot()
            print("[face-lab] Telegram bot starting...", flush=True)
            loop.run_until_complete(bot_app.initialize())
            loop.run_until_complete(bot_app.start())
            loop.run_until_complete(bot_app.updater.start_polling(drop_pending_updates=True))
            print("[face-lab] Telegram bot is running!", flush=True)
            loop.run_forever()
        except Exception as e:
            print(f"[face-lab] Bot error: {type(e).__name__}: {e}", flush=True)
            import traceback
            traceback.print_exc()

    _bot_thread = threading.Thread(target=_run, daemon=True, name="telegram-bot")
    _bot_thread.start()
    print("[face-lab] Bot thread started", flush=True)


def main() -> None:
    import uvicorn

    host = os.environ.get("HOST", os.environ.get("FACE_LAB_HOST", "0.0.0.0"))
    port = int(os.environ.get("PORT", os.environ.get("FACE_LAB_PORT", "8000")))

    if os.environ.get("FACE_LAB_BOT", "1") == "1":
        _start_bot_background()

    print(f"[face-lab] http://{host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()




