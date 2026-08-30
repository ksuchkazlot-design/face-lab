/* ==========================================================================
   FACE LAB - controller shared by the six detail pages.
   Reads ?metric= and renders score, scale, overlay, tabs and pager.
   ========================================================================== */

(function () {
  "use strict";

  var FL = window.FaceLab;

  /* Landmark pairs highlighted per metric on the photo overlay. */
  var METRIC_OVERLAY = {
    canthal_tilt: [[33, 133], [263, 362]],
    lower_third: [[2, 152]],
    eye_separation: [[133, 362], [234, 454]],
    mouth_nose_ratio: [[61, 291], [129, 358]],
    facial_thirds_balance: [[10, 9], [9, 2], [2, 152]],
    vertical_symmetry: [[10, 152], [33, 263], [61, 291]],
    horizontal_symmetry: [[33, 263], [61, 291], [132, 288]],
    golden_ratio: [[10, 152], [234, 454]],
    midface_ratio: [[33, 263], [61, 291], [168, 0]],
    face_length_ratio: [[10, 152], [234, 454]],
    interocular_ratio: [[133, 362], [33, 133]],
    eye_spacing_symmetry: [[10, 152], [33, 133], [263, 362]],

    gonial_angle: [[127, 132], [132, 152], [356, 288], [288, 152]],
    cheekbone_prominence: [[234, 454], [127, 356]],
    jaw_cheek_ratio: [[132, 288], [234, 454]],
    jaw_frontal_angle: [[132, 152], [288, 152]],
    chin_width_ratio: [[148, 377], [132, 288]],
    mandible_definition: [[132, 288], [132, 152], [288, 152]],
    ramus_ratio: [[127, 132], [132, 152]],
    bigonial_width: [[132, 288], [10, 152]],
    chin_projection: [[2, 152], [132, 152]],
    jaw_mass: [[132, 288], [2, 152]],

    brow_ridge: [[105, 159], [334, 386]],
    lip_thickness: [[0, 13], [14, 17], [61, 291]],
    dimorphism_index: [[105, 159], [132, 288], [17, 152]],
    brow_tilt: [[55, 46], [285, 276]],
    eye_aperture: [[159, 145], [386, 374]],
    cheek_fullness: [[205, 425], [234, 454]],
    chin_height_ratio: [[17, 152], [2, 152]],

    eye_size: [[33, 133], [263, 362], [234, 454]],
    nose_width: [[129, 358], [234, 454]],
    lip_width: [[61, 291], [234, 454]],
    nose_length: [[168, 2]],
    nasal_index: [[129, 358], [168, 2]],
    philtrum_length: [[2, 0]],
    upper_lip_ratio: [[0, 13], [14, 17]],
    nose_height_ratio: [[168, 2], [10, 152]],
    mouth_width_ratio: [[61, 291], [33, 263]]
  };

  /* Reference figures used on the Celebrities tab. Public, widely cited
     aesthetic reference points rather than measured private data. */
  var CELEBS = {
    canthal_tilt: [
      { name: "Выраженный подъём", value: 8.0, note: "открытый взгляд" },
      { name: "Нейтральный", value: 4.0, note: "средний ориентир" },
      { name: "Опущенный", value: -1.0, note: "мягкий взгляд" }
    ],
    gonial_angle: [
      { name: "Резкая челюсть", value: 116.0, note: "острый угол" },
      { name: "Средний ориентир", value: 124.0, note: "баланс" },
      { name: "Мягкая линия", value: 134.0, note: "округлый контур" }
    ],
    lip_thickness: [
      { name: "Полные губы", value: 0.46, note: "высокий объём" },
      { name: "Средний ориентир", value: 0.37, note: "баланс" },
      { name: "Тонкие губы", value: 0.27, note: "сдержанный объём" }
    ],
    eye_size: [
      { name: "Крупные глаза", value: 0.262, note: "выразительно" },
      { name: "Средний ориентир", value: 0.232, note: "баланс" },
      { name: "Узкие глаза", value: 0.205, note: "сдержанно" }
    ],
    skin_tone_ita: [
      { name: "Очень светлая кожа", value: 55.0, note: "ITA > 55" },
      { name: "Светлая", value: 41.0, note: "ITA 41–55" },
      { name: "Средняя", value: 28.0, note: "ITA 28–41" },
      { name: "Смуглая", value: 10.0, note: "ITA 10–28" },
      { name: "Тёмная", value: -20.0, note: "ITA < 10" }
    ]
  };

  var TAB_KEYS = ["overview", "simulate", "celebrities", "edit"];

  var state = {
    report: null,
    metric: null,
    catKey: null,
    siblings: [],
    tab: "overview"
  };

  /* ------------------------------------------------------------- rendering */

  function renderHeader() {
    var metric = state.metric;
    FL.$("detailTitle").textContent = metric.label;
    FL.$("detailUnit").textContent = metric.unit
      ? "измеряется в " + (metric.unit === "%" ? "процентах" : "градусах")
      : "безразмерное отношение";

    FL.$("bigValue").textContent = metric.display;
    FL.$("bigScore").textContent = "0.0";
    FL.countUp(FL.$("bigScore"), metric.score, 900, "");
    FL.$("bigScore").style.color = FL.colorVar(metric.color);
    FL.$("bigRating").textContent = metric.rating_ru;
    FL.$("bigPercentile").textContent = "0%";
    FL.countUp(FL.$("bigPercentile"), metric.percentile, 900, "%");

    var badge = FL.$("statusBadge");
    badge.textContent = metric.direction_ru;
    badge.className = "badge " + FL.softClass(metric.color);

    var bar = FL.$("scoreBar");
    bar.style.background = FL.colorVar(metric.color);
    window.setTimeout(function () {
      bar.style.width = FL.clamp(metric.score * 10, 0, 100) + "%";
    }, 140);

    FL.$("headerScore").textContent = "0.0";
    FL.countUp(FL.$("headerScore"), metric.score, 900, "");
    FL.$("headerScore").style.color = FL.colorVar(metric.color);
  }

  function renderScale() {
    FL.$("scaleHost").innerHTML = FL.buildScale(state.metric);
    FL.$("scaleLegend").innerHTML =
      '<span><i class="bg-teal"></i> норма</span>' +
      '<span><i class="bg-beige"></i> отклонение</span>' +
      '<span><i class="bg-rose"></i> сильное отклонение</span>';
  }

  function getContributesInsights(metric) {
    var list = [];
    var isNorm = metric.score >= 7.5;

    if (metric.category === "harmony") {
      list.push({
        icon: "📐",
        title: "Facial Proportion & Compactness",
        desc: isNorm ? "Показатель находится в оптимальном балансе, обеспечивая естественную гармонию пропорций лица."
                     : "Отклонение влияет на восприятие компактности лица и вертикальное соотношение третей."
      });
      list.push({
        icon: "✨",
        title: "Symmetry & Aesthetic Attractiveness",
        desc: "Формирует баланс правой и левой сторон, снижая визуальную асимметрию при естественной мимике."
      });
      if (metric.advice_ru) {
        list.push({
          icon: "💡",
          title: "Actionable Guidance",
          desc: metric.advice_ru
        });
      }
    } else if (metric.category === "angularity") {
      list.push({
        icon: "🦴",
        title: "Mandibular Definition & Occlusion",
        desc: isNorm ? "Чёткий контур челюсти создаёт выразительную тень и визуально отделяет подбородок от шеи."
                     : "Влияет на выраженность угла челюсти, осанку шеи и натяжение подчелюстной зоны."
      });
      list.push({
        icon: "👤",
        title: "Submental Cervical Contour",
        desc: "Сбалансированное значение минимизирует склонность к отёчности и сохраняет молодой контур профиля."
      });
      if (metric.advice_ru) {
        list.push({
          icon: "🎯",
          title: "Masseter Tone & Posture",
          desc: metric.advice_ru
        });
      }
    } else if (metric.category === "dimorphism") {
      list.push({
        icon: "🧬",
        title: "Secondary Sexual Characteristics",
        desc: "Определяет степень выраженности характерных маскулинных или феминных черт внешности."
      });
      list.push({
        icon: "👁",
        title: "Brow Prominence & Gaze Sharpness",
        desc: isNorm ? "Гармоничное сочетание мягкости и скульптурности взгляда."
                     : "Влияет на глубину посадки глаз и геометрию надбровных дуг."
      });
      if (metric.advice_ru) {
        list.push({
          icon: "💡",
          title: "Styling Strategy",
          desc: metric.advice_ru
        });
      }
    } else if (metric.category === "features") {
      list.push({
        icon: "🎯",
        title: "Central Feature Harmony",
        desc: "Сбалансированное соотношение ширины носа, длины фильтрума и проекции губ."
      });
      list.push({
        icon: "👀",
        title: "Canthal Tilt & Eye Openness",
        desc: "Определяет вектор взгляда (положительный кантус создаёт открытый и свежий вид)."
      });
      if (metric.advice_ru) {
        list.push({
          icon: "✨",
          title: "Practical Recommendation",
          desc: metric.advice_ru
        });
      }
    } else if (metric.category === "skin") {
      list.push({
        icon: "🌿",
        title: "Dermal Texture & Luminosity",
        desc: "Отражает чистоту микрорельефа, равномерность светорассеяния и плотность защитного барьера."
      });
      list.push({
        icon: "🛡",
        title: "Skin Barrier & Even Tone",
        desc: isNorm ? "Минимальный уровень воспалений и ровный цветовой баланс кожи."
                     : "Рекомендуется усилить базовое увлажнение, использовать SPF и антиоксиданты."
      });
      if (metric.advice_ru) {
        list.push({
          icon: "🧴",
          title: "Skincare Protocol",
          desc: metric.advice_ru
        });
      }
    } else {
      list.push({
        icon: "✂️",
        title: "Hairline Frame & Density",
        desc: "Форма линии роста волос формирует пропорции лба и балансирует верхнюю треть лица."
      });
      list.push({
        icon: "💆",
        title: "Scalp Microcirculation & Volume",
        desc: "Плотность волос и качество прикорневого объёма определяют общую архитектуру образа."
      });
      if (metric.advice_ru) {
        list.push({
          icon: "💈",
          title: "Styling & Grooming",
          desc: metric.advice_ru
        });
      }
    }
    return list;
  }

  function buildBellCurveSvg(metric) {
    var width = 380;
    var height = 120;
    var padding = { left: 28, right: 28, top: 22, bottom: 24 };
    var plotW = width - padding.left - padding.right;
    var plotH = height - padding.top - padding.bottom;

    var min = metric.scale_min;
    var max = metric.scale_max;
    var idealLow = metric.ideal_low;
    var idealHigh = metric.ideal_high;
    var center = metric.ideal_center;
    var sigma = metric.sigma || Math.max((idealHigh - idealLow) / 2, 0.01);
    var val = metric.value;

    function toX(xVal) {
      return padding.left + ((xVal - min) / Math.max(max - min, 1e-6)) * plotW;
    }
    function getY(xVal) {
      return Math.exp(-Math.pow(xVal - center, 2) / (2 * sigma * sigma));
    }
    function toY(prob) {
      return padding.top + (1 - prob) * plotH;
    }

    var steps = 60;
    var d = "M " + padding.left + " " + (padding.top + plotH);
    for (var i = 0; i <= steps; i++) {
      var curVal = min + (i / steps) * (max - min);
      var prob = getY(curVal);
      d += " L " + toX(curVal).toFixed(1) + " " + toY(prob).toFixed(1);
    }

    var idealX1 = Math.max(toX(idealLow), padding.left);
    var idealX2 = Math.min(toX(idealHigh), width - padding.right);
    var idealW = Math.max(idealX2 - idealX1, 4);

    var userX = FL.clamp(toX(val), padding.left + 8, width - padding.right - 8);
    var userProb = getY(val);
    var userY = toY(userProb);

    return '<svg viewBox="0 0 ' + width + ' ' + height + '" class="scoring-curve-svg">' +
      '<defs>' +
        '<linearGradient id="bellGrad_' + metric.key + '" x1="0" y1="0" x2="1" y2="0">' +
          '<stop offset="0%" stop-color="#F87171" />' +
          '<stop offset="42%" stop-color="#2BB8A8" />' +
          '<stop offset="58%" stop-color="#2BB8A8" />' +
          '<stop offset="100%" stop-color="#F87171" />' +
        '</linearGradient>' +
      '</defs>' +
      '<rect x="' + idealX1.toFixed(1) + '" y="' + padding.top + '" width="' + idealW.toFixed(1) + '" height="' + plotH + '" fill="rgba(43, 184, 168, 0.14)" stroke="rgba(43, 184, 168, 0.3)" stroke-dasharray="2,2" />' +
      '<line x1="' + padding.left + '" y1="' + (padding.top + plotH) + '" x2="' + (width - padding.right) + '" y2="' + (padding.top + plotH) + '" stroke="#e5e7eb" stroke-width="1.5" />' +
      '<path d="' + d + '" fill="none" stroke="url(#bellGrad_' + metric.key + ')" stroke-width="2.5" stroke-linecap="round" />' +
      '<line x1="' + userX.toFixed(1) + '" y1="' + (padding.top + plotH) + '" x2="' + userX.toFixed(1) + '" y2="' + userY.toFixed(1) + '" stroke="#111827" stroke-width="1.5" stroke-dasharray="3,3" />' +
      '<circle cx="' + userX.toFixed(1) + '" cy="' + userY.toFixed(1) + '" r="5" fill="#2BB8A8" stroke="#111827" stroke-width="2" />' +
      '<rect x="' + (userX - 24).toFixed(1) + '" y="' + Math.max(userY - 20, 2).toFixed(1) + '" width="48" height="15" rx="4" fill="#111827" />' +
      '<text x="' + userX.toFixed(1) + '" y="' + (Math.max(userY - 20, 2) + 11).toFixed(1) + '" text-anchor="middle" fill="#ffffff" font-size="9.5" font-weight="700">' + metric.display + '</text>' +
      '<text x="' + padding.left + '" y="' + (height - 6) + '" fill="#9ca3af" font-size="9">' + FL.fmt(min, 1) + '</text>' +
      '<text x="' + toX(center).toFixed(1) + '" y="' + (height - 6) + '" text-anchor="middle" fill="#2BB8A8" font-size="9" font-weight="600">' + FL.fmt(center, 1) + '</text>' +
      '<text x="' + (width - padding.right) + '" y="' + (height - 6) + '" text-anchor="end" fill="#9ca3af" font-size="9">' + FL.fmt(max, 1) + '</text>' +
    '</svg>';
  }

  function renderAbout() {
    var metric = state.metric;
    var insights = getContributesInsights(metric);
    var contribHtml = '<div class="contributes-list" style="margin-top:12px;">';
    insights.forEach(function (c) {
      contribHtml +=
        '<div class="contributes-item">' +
          '<span class="contributes-item__icon">' + c.icon + "</span>" +
          "<div>" +
            '<div class="contributes-item__title">' + c.title + "</div>" +
            '<div class="contributes-item__desc">' + c.desc + "</div>" +
          "</div>" +
        "</div>";
    });
    contribHtml += "</div>";

    var curveHtml =
      '<div class="scoring-curve-box" style="margin-top:20px;">' +
        '<div class="scoring-curve-header">' +
          '<span class="scoring-curve-title">SCORING CURVE</span>' +
          '<span class="scoring-curve-val-indicator">YOUR VALUE <span style="color:var(--teal);">' + metric.display + " (" + FL.fmt(metric.score, 1) + "/10)</span></span>" +
        "</div>" +
        buildBellCurveSvg(metric) +
      "</div>";

    FL.$("aboutText").innerHTML =
      "<p>" + metric.description_ru + "</p>" +
      "<p>Ваше значение — <strong>" + metric.display + "</strong>, что " +
        metric.direction_ru + ". Референсный коридор: " +
        FL.fmt(metric.ideal_low, 3) + " – " + FL.fmt(metric.ideal_high, 3) +
        ", центр " + FL.fmt(metric.ideal_center, 3) + ".</p>" +
      (metric.advice_ru
        ? '<p class="advice"><strong>Рекомендация:</strong> ' + metric.advice_ru + "</p>"
        : "") +
      '<div style="margin-top: 20px;"><strong style="font-size:11px;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);">CONTRIBUTES TO</strong>' +
      contribHtml + '</div>' +
      curveHtml;

    FL.$("metaCategory").textContent = FL.CAT_RU[metric.category] +
      " (" + metric.category + ")";
    FL.$("metaKey").textContent = metric.key;
    FL.$("metaValue").textContent = metric.display;
    FL.$("metaRange").textContent =
      FL.fmt(metric.ideal_low, 3) + " – " + FL.fmt(metric.ideal_high, 3);
    FL.$("metaCenter").textContent = FL.fmt(metric.ideal_center, 3);
    FL.$("metaSigma").textContent = FL.fmt(metric.sigma, 3);
    FL.$("metaSource").textContent = metric.source === "profile" ? "профиль" : "анфас";
    FL.$("metaPercentile").textContent = metric.percentile + "%";
  }

  function renderSiblings() {
    var host = FL.$("siblingList");
    host.innerHTML = "";
    state.siblings.forEach(function (metric) {
      var row = FL.metricRow(metric, function (target) {
        window.location.href = "/details/" + target.category +
          "-detail.html?metric=" + target.key;
      });
      if (metric.key === state.metric.key) {
        row.style.background = "var(--bg)";
      }
      host.appendChild(row);
    });
    FL.staggerReveal(host, ".ratio-row");
  }

  /* ---------------------------------------------------------- simulate tab */

  function initSimulate() {
    var metric = state.metric;
    var range = FL.$("simRange");
    var min = metric.scale_min;
    var max = metric.scale_max;
    var span = Math.max(max - min, 1e-6);

    function paint(reset) {
      if (reset) {
        range.value = String(Math.round(((metric.value - min) / span) * 100));
      }
      var ratio = Number(range.value) / 100;
      var value = min + ratio * span;
      var score = FL.gaussianScore(value, metric.ideal_low, metric.ideal_high);
      var color = FL.scoreColorName(score);

      FL.$("simValue").textContent = metric.unit === "%"
        ? FL.fmt(value, 1) + "%"
        : metric.unit === "°"
          ? FL.fmt(value, 1) + "°"
          : FL.fmt(value, 3);

      FL.$("simScaleHost").innerHTML = FL.buildScale(metric, { value: value });

      var scoreEl = FL.$("simScore");
      scoreEl.textContent = FL.fmt(score, 1) + " / 10";
      scoreEl.style.color = FL.colorVar(color);

      var delta = score - metric.score;
      var deltaEl = FL.$("simDelta");
      deltaEl.textContent = (delta >= 0 ? "+" : "") + FL.fmt(delta, 1);
      deltaEl.style.color = delta >= 0 ? "var(--teal)" : "var(--rose)";

      FL.$("simHint").textContent = describeSimulation(value, metric);
    }

    range.addEventListener("input", function () {
      paint(false);
    });
    FL.$("simResetBtn").addEventListener("click", function () {
      paint(true);
    });
    FL.$("simIdealBtn").addEventListener("click", function () {
      range.value = String(Math.round(((metric.ideal_center - min) / span) * 100));
      paint(false);
    });

    FL.$("simMetricLabel").textContent = metric.label;
    paint(true);
  }

  function describeSimulation(value, metric) {
    var diff = value - metric.value;
    if (Math.abs(diff) < (metric.scale_max - metric.scale_min) * 0.01) {
      return "Это ваше текущее значение.";
    }
    var word = diff > 0 ? "выше" : "ниже";
    var target = value >= metric.ideal_low && value <= metric.ideal_high
      ? "внутри референсного коридора"
      : "за пределами коридора";
    return "Смоделировано значение " + word + " текущего, " + target + ".";
  }

  /* ------------------------------------------------------- celebrities tab */

  function renderCelebs() {
    var metric = state.metric;
    var host = FL.$("celebList");
    host.innerHTML = "";

    var rows = CELEBS[metric.key];
    if (!rows) {
      rows = [
        { name: "Нижняя граница нормы", value: metric.ideal_low, note: "порог коридора" },
        { name: "Центр нормы", value: metric.ideal_center, note: "10 баллов" },
        { name: "Верхняя граница нормы", value: metric.ideal_high, note: "порог коридора" }
      ];
      FL.$("celebNote").textContent =
        "Для этой метрики показаны опорные точки референсного коридора.";
    } else {
      FL.$("celebNote").textContent =
        "Общепринятые эстетические ориентиры для сравнения, не измерения " +
        "конкретных людей.";
    }

    rows.forEach(function (row, i) {
      var score = FL.gaussianScore(row.value, metric.ideal_low, metric.ideal_high);
      var diff = row.value - metric.value;
      var item = document.createElement("div");
      item.className = "celeb-row stagger-child";
      item.style.animationDelay = (i * 0.08 + 0.05) + "s";
      item.innerHTML =
        '<span class="celeb-row__avatar">' + row.name.charAt(0) + "</span>" +
        "<div style='min-width:0'>" +
          '<div class="celeb-row__name">' + row.name + "</div>" +
          '<div class="celeb-row__note">' + row.note + ' · балл <span class="celeb-score">0.0</span></div>' +
        "</div>" +
        '<span class="celeb-row__val">' +
          '<span class="celeb-row__num">' + FL.fmt(row.value, 2) + "</span>" +
          '<span class="celeb-row__diff">' + (diff >= 0 ? "+" : "") +
            FL.fmt(diff, 2) + " к вам</span>" +
        "</span>";
      host.appendChild(item);

      var scoreSpan = item.querySelector(".celeb-score");
      window.setTimeout(function () {
        FL.countUp(scoreSpan, score, 500, "");
      }, 200 + i * 80);
    });
  }

  /* -------------------------------------------------------------- edit tab */

  function noteKey() {
    return "faceLabNote:" + state.metric.key;
  }

  function initEdit() {
    var area = FL.$("noteArea");
    var flag = FL.$("savedFlag");
    var stored = FL.safeGet(noteKey());
    if (stored) {
      area.value = stored;
    }

    FL.$("noteSave").addEventListener("click", function () {
      var ok = FL.safeSet(noteKey(), area.value);
      if (ok) {
        flag.classList.add("is-on");
        window.setTimeout(function () {
          flag.classList.remove("is-on");
        }, 1800);
      } else {
        FL.toast("Не удалось сохранить заметку.", true);
      }
    });

    FL.$("noteClear").addEventListener("click", function () {
      area.value = "";
      FL.safeSet(noteKey(), "");
      FL.toast("Заметка очищена");
    });

    FL.$("copyBtn").addEventListener("click", function () {
      var metric = state.metric;
      var text = metric.label + ": " + metric.display +
        " (балл " + FL.fmt(metric.score, 1) + "/10, норма " +
        FL.fmt(metric.ideal_low, 3) + "–" + FL.fmt(metric.ideal_high, 3) + ")";
      if (window.navigator.clipboard && window.navigator.clipboard.writeText) {
        window.navigator.clipboard.writeText(text).then(function () {
          FL.toast("Скопировано");
        }).catch(function () {
          FL.toast("Копирование недоступно", true);
        });
      } else {
        FL.toast("Копирование недоступно", true);
      }
    });
  }

  /* ------------------------------------------------------------------ tabs */

  function setTab(tab) {
    state.tab = tab;
    TAB_KEYS.forEach(function (key) {
      var panel = FL.$("tab-" + key);
      if (panel) {
        panel.classList.toggle("is-active", key === tab);
      }
    });
    FL.qsa(".tabs__btn").forEach(function (button) {
      button.classList.toggle("is-active", button.getAttribute("data-tab") === tab);
    });
  }

  function bindTabs() {
    FL.qsa(".tabs__btn").forEach(function (button) {
      button.addEventListener("click", function () {
        setTab(button.getAttribute("data-tab"));
      });
    });
  }

  /* ----------------------------------------------------------------- pager */

  function renderPager() {
    var keys = state.siblings.map(function (metric) {
      return metric.key;
    });
    var index = keys.indexOf(state.metric.key);
    var prev = index > 0 ? state.siblings[index - 1] : null;
    var next = index >= 0 && index < state.siblings.length - 1
      ? state.siblings[index + 1]
      : null;

    var prevBtn = FL.$("prevBtn");
    var nextBtn = FL.$("nextBtn");

    if (prev) {
      FL.$("prevName").textContent = prev.label;
      prevBtn.addEventListener("click", function () {
        window.location.href = "/details/" + prev.category +
          "-detail.html?metric=" + prev.key;
      });
    } else {
      prevBtn.disabled = true;
      FL.$("prevName").textContent = "Начало";
    }

    if (next) {
      FL.$("nextName").textContent = next.label;
      nextBtn.addEventListener("click", function () {
        window.location.href = "/details/" + next.category +
          "-detail.html?metric=" + next.key;
      });
    } else {
      nextBtn.disabled = true;
      FL.$("nextName").textContent = "Конец";
    }

    FL.$("pagerPos").textContent = (index + 1) + " из " + state.siblings.length;
  }

  /* ------------------------------------------------------------------ init */

  function init(options) {
    var report = FL.loadReport();
    if (!report) {
      FL.showEmptyState("page",
        "Откройте метрику после того, как выполните анализ на главной странице.");
      return;
    }

    var cat = FL.category(report, options.category);
    if (!cat || !cat.metrics || !cat.metrics.length) {
      FL.showEmptyState("page", "В отчёте нет метрик этой категории.");
      return;
    }

    var requested = FL.queryParam("metric");
    var metric = null;
    cat.metrics.forEach(function (candidate) {
      if (candidate.key === requested) {
        metric = candidate;
      }
    });
    if (!metric) {
      metric = cat.metrics[0];
    }

    state.report = report;
    state.metric = metric;
    state.catKey = options.category;
    state.siblings = cat.metrics;

    FL.bindStickyHeader(report, {
      title: metric.label,
      sub: cat.title + " · " + cat.title_ru,
      backHref: "/analysis/" + options.category + ".html"
    });
    FL.bindPhotoToggle(report, {
      overlay: METRIC_OVERLAY[metric.key] || "mesh"
    });

    renderHeader();
    renderScale();
    renderAbout();
    renderSiblings();
    bindTabs();
    initSimulate();
    renderCelebs();
    initEdit();
    renderPager();
    setTab("overview");

    FL.$("catLink").setAttribute("href", "/analysis/" + options.category + ".html");
    FL.$("catLink").textContent = "Вся категория " + cat.title;
  }

  window.FaceLabDetail = { init: init };
})();
