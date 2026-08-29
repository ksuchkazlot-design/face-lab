/* ==========================================================================
   FACE LAB - controller shared by the six analysis pages.
   Each page calls window.FaceLabPage.init({ key, title, index, overlayPairs }).
   ========================================================================== */

(function () {
  "use strict";

  var FL = window.FaceLab;

  var CAT_TITLES = {
    harmony: "Harmony",
    angularity: "Angularity",
    dimorphism: "Dimorphism",
    features: "Features",
    skin: "Skin",
    hair: "Hair"
  };

  var CAT_NOTE = {
    harmony: "Баланс зон лица, симметрия и соотношения ширин.",
    angularity: "Резкость линии челюсти и выступание скул.",
    dimorphism: "Соответствие черт выбранному полу.",
    features: "Размеры отдельных элементов лица.",
    skin: "Цвет, ровность и текстура кожи по пикселям кадра.",
    hair: "Плотность, тон и однородность волос."
  };

  function detailHref(metric) {
    return "/details/" + metric.category + "-detail.html?metric=" + metric.key;
  }

  function renderScoreCard(cat) {
    FL.$("catScore").textContent = "0.0";
    FL.countUp(FL.$("catScore"), cat.score, 900, "");
    FL.$("catRating").textContent = cat.rating_ru;
    FL.$("catPercentile").textContent = "0%";
    FL.countUp(FL.$("catPercentile"), cat.percentile, 900, "%");
    FL.$("catNote").textContent = CAT_NOTE[cat.key] +
      " Посчитано метрик: " + cat.metric_count + ".";
    FL.$("headerScore").textContent = "0.0";
    FL.countUp(FL.$("headerScore"), cat.score, 900, "");
    FL.$("headerScore").style.color = FL.colorVar(cat.color);

    var dial = FL.$("catDial");
    var circumference = 2 * Math.PI * 52;
    dial.setAttribute("stroke-dasharray", String(circumference));
    dial.style.stroke = FL.colorVar(cat.color);
    window.setTimeout(function () {
      dial.setAttribute("stroke-dashoffset",
        String(circumference * (1 - FL.clamp(cat.score / 10, 0, 1))));
    }, 140);
  }

  function renderRatios(cat) {
    var host = FL.$("ratioList");
    host.innerHTML = "";
    (cat.metrics || []).forEach(function (metric) {
      host.appendChild(FL.metricRow(metric, function (target) {
        window.location.href = detailHref(target);
      }));
    });
    FL.$("metricCount").textContent = (cat.metrics || []).length + " шт.";
    FL.staggerReveal(host, ".ratio-row");
  }

  function renderInsights(cat) {
    var strengths = FL.$("strengthsList");
    var improvements = FL.$("improvementsList");
    strengths.innerHTML = "";
    improvements.innerHTML = "";

    var strengthItems = cat.strengths || [];
    var improveItems = cat.improvements || [];

    if (!strengthItems.length) {
      strengths.innerHTML =
        '<li class="insight"><span class="insight__icon soft-beige">•</span>' +
        '<div><div class="insight__name">Пока нет метрик выше 6.0</div>' +
        '<div class="insight__desc">Смотрите зоны роста ниже.</div></div></li>';
    }

    strengthItems.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "insight";
      var color = FL.scoreColorName(item.score);
      li.innerHTML =
        '<span class="insight__icon ' + FL.softClass(color) + '">↑</span>' +
        "<div>" +
          '<div class="insight__name">' + item.label + "</div>" +
          '<div class="insight__desc">' + item.display + " · " + item.rating_ru + "</div>" +
          (item.advice_ru ? '<div class="insight__advice">' + item.advice_ru + "</div>" : "") +
        "</div>" +
        '<span class="insight__score" style="color:' + FL.colorVar(color) + '">' +
          FL.fmt(item.score, 1) + "</span>";
      strengths.appendChild(li);
    });

    if (!improveItems.length) {
      improvements.innerHTML =
        '<li class="insight"><span class="insight__icon soft-teal">✓</span>' +
        '<div><div class="insight__name">Все метрики в норме</div>' +
        '<div class="insight__desc">Каждый показатель категории выше 7.0.</div></div></li>';
    }

    improveItems.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "insight";
      var color = FL.scoreColorName(item.score);
      li.innerHTML =
        '<span class="insight__icon ' + FL.softClass(color) + '">↓</span>' +
        "<div>" +
          '<div class="insight__name">' + item.label + "</div>" +
          '<div class="insight__desc">' + item.display + " · " + item.direction_ru + "</div>" +
          (item.advice_ru ? '<div class="insight__advice">' + item.advice_ru + "</div>" : "") +
        "</div>" +
        '<span class="insight__score" style="color:' + FL.colorVar(color) + '">' +
          FL.fmt(item.score, 1) + "</span>";
      improvements.appendChild(li);
    });
  }

  function renderSpread(cat) {
    var host = FL.$("spreadList");
    host.innerHTML = "";
    var sorted = (cat.metrics || []).slice().sort(function (a, b) {
      return b.score - a.score;
    });

    sorted.forEach(function (metric, i) {
      var row = document.createElement("div");
      row.style.marginBottom = "13px";
      row.style.opacity = "0";
      row.style.animationDelay = (i * 0.06 + 0.05) + "s";
      row.classList.add("stagger-child");
      row.innerHTML =
        '<div class="row row--between" style="margin-bottom:6px">' +
          '<span style="font-size:12.5px;font-weight:600">' + metric.label + "</span>" +
          '<span class="spread-score" style="font-size:12.5px;font-weight:700;color:' +
            FL.colorVar(metric.color) + '">0.0</span>' +
        "</div>" +
        '<div class="cat-card__bar" style="margin:0"><span class="cat-card__fill"></span></div>';
      var fill = row.querySelector(".cat-card__fill");
      fill.style.background = FL.colorVar(metric.color);
      var scoreEl = row.querySelector(".spread-score");
      window.setTimeout(function () {
        fill.style.width = FL.clamp(metric.score * 10, 0, 100) + "%";
        FL.countUp(scoreEl, metric.score, 600, "");
      }, 180 + i * 60);
      host.appendChild(row);
    });
  }

  function renderReference(report, cat) {
    var host = FL.$("refTable");
    host.innerHTML = "";
    (cat.metrics || []).forEach(function (metric) {
      var row = document.createElement("div");
      row.className = "kv";
      row.innerHTML =
        '<span class="kv__k">' + metric.label +
          (metric.unit ? " (" + metric.unit + ")" : "") + "</span>" +
        '<span class="kv__v">' + FL.fmt(metric.ideal_low, 2) + " – " +
          FL.fmt(metric.ideal_high, 2) + "</span>";
      host.appendChild(row);
    });
    FL.$("refMeta").textContent =
      FL.GENDER_RU[report.gender] + " / " + FL.ETH_RU[report.ethnicity];
  }

  function renderPager(index) {
    var order = FL.CAT_ORDER;
    var prev = index > 0 ? order[index - 1] : null;
    var next = index < order.length - 1 ? order[index + 1] : null;

    var prevBtn = FL.$("prevBtn");
    var nextBtn = FL.$("nextBtn");

    if (prev) {
      FL.$("prevName").textContent = CAT_TITLES[prev];
      prevBtn.addEventListener("click", function () {
        window.location.href = "/analysis/" + prev + ".html";
      });
    } else {
      FL.$("prevName").textContent = "Отчёт";
      prevBtn.addEventListener("click", function () {
        window.location.href = "/";
      });
    }

    if (next) {
      FL.$("nextName").textContent = CAT_TITLES[next];
      nextBtn.addEventListener("click", function () {
        window.location.href = "/analysis/" + next + ".html";
      });
    } else {
      FL.$("nextName").textContent = "Отчёт";
      nextBtn.addEventListener("click", function () {
        window.location.href = "/";
      });
    }
  }

  function init(options) {
    var report = FL.loadReport();
    if (!report) {
      FL.showEmptyState("page",
        "Чтобы увидеть эту категорию, сначала загрузите фото и выполните анализ.");
      return;
    }

    var cat = FL.category(report, options.key);
    if (!cat) {
      FL.showEmptyState("page", "Данные категории отсутствуют в отчёте.");
      return;
    }

    FL.bindStickyHeader(report, { title: options.title, backHref: "/" });
    FL.bindPhotoToggle(report, { overlay: options.overlayPairs || "mesh" });

    renderScoreCard(cat);
    renderRatios(cat);
    renderInsights(cat);
    renderSpread(cat);
    renderReference(report, cat);
    renderPager(options.index);
  }

  window.FaceLabPage = { init: init };
})();
