/* ==========================================================================
   FACE LAB - shared runtime for analysis and detail pages.
   Reads the report from localStorage and exposes window.FaceLab.
   ========================================================================== */

(function () {
  "use strict";

  var STORAGE = {
    analysis: "faceAnalysis",
    front: "frontPhoto",
    profile: "profilePhoto",
    gender: "gender",
    ethnicity: "ethnicity"
  };

  var GENDER_RU = { male: "Мужской", female: "Женский" };
  var ETH_RU = {
    caucasian: "Европейский",
    asian: "Азиатский",
    african: "Африканский",
    middle_eastern: "Ближневосточный"
  };

  var CAT_ORDER = ["harmony", "angularity", "dimorphism", "features"];

  var CAT_RU = {
    harmony: "Гармония",
    angularity: "Угловатость",
    dimorphism: "Диморфизм",
    features: "Черты лица"
  };

  function safeGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function safeSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  function $(id) {
    return document.getElementById(id);
  }

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  function fmt(value, digits) {
    var d = typeof digits === "number" ? digits : 2;
    return Number(value).toFixed(d);
  }

  function colorVar(color) {
    return "var(--" + (color || "green") + ")";
  }

  function softClass(color) {
    return "soft-" + (color || "green");
  }

  function scoreColorName(score) {
    if (score >= 8) {
      return "teal";
    }
    if (score >= 6) {
      return "green";
    }
    if (score >= 4) {
      return "beige";
    }
    return "rose";
  }

  function gaussianScore(value, lo, hi) {
    var center = (lo + hi) / 2;
    var half = Math.max(Math.abs(hi - lo) / 2, 1e-6);
    var sigma = half / Math.sqrt(2 * Math.log(10 / 8.7));
    var raw = 10 * Math.exp(-Math.pow(value - center, 2) / (2 * sigma * sigma));
    return clamp(raw, 0, 10);
  }

  function scoreLabelRu(score) {
    if (score >= 9) {
      return "Исключительно";
    }
    if (score >= 8) {
      return "Отлично";
    }
    if (score >= 6.5) {
      return "Хорошо";
    }
    if (score >= 5) {
      return "Средне";
    }
    if (score >= 3.5) {
      return "Ниже среднего";
    }
    return "Есть над чем работать";
  }

  function loadReport() {
    var raw = safeGet(STORAGE.analysis);
    if (!raw) {
      return null;
    }
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.metrics || !parsed.overall || !parsed.categories) {
        return null;
      }
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function category(report, key) {
    var found = null;
    (report.categories || []).forEach(function (cat) {
      if (cat.key === key) {
        found = cat;
      }
    });
    return found;
  }

  function queryParam(name) {
    var params = new URLSearchParams(window.location.search);
    return params.get(name);
  }

  function toast(message, isError) {
    var el = $("toast");
    if (!el) {
      return;
    }
    el.textContent = message;
    el.className = "toast is-on" + (isError ? " toast--error" : "");
    window.clearTimeout(el._timer);
    el._timer = window.setTimeout(function () {
      el.className = "toast" + (isError ? " toast--error" : "");
    }, 3000);
  }

  function showEmptyState(hostId, message) {
    var host = $(hostId);
    if (!host) {
      return;
    }
    host.innerHTML =
      '<div class="empty">' +
        '<div class="empty__glyph" aria-hidden="true">◌</div>' +
        '<div class="empty__title">Нет данных анализа</div>' +
        '<p class="empty__text">' + message + "</p>" +
        '<a class="btn btn--primary" href="/">Пройти анализ</a>' +
      "</div>";
  }

  /* -------------------------------------------------------- shared widgets */

  function buildScale(metric, options) {
    var opts = options || {};
    var value = typeof opts.value === "number" ? opts.value : metric.value;
    var min = metric.scale_min;
    var max = metric.scale_max;
    var span = Math.max(max - min, 1e-6);

    var idealLeft = clamp(((metric.ideal_low - min) / span) * 100, 0, 100);
    var idealWidth = clamp(((metric.ideal_high - metric.ideal_low) / span) * 100, 0, 100);
    var centerLeft = clamp(((metric.ideal_center - min) / span) * 100, 0, 100);
    var markerLeft = clamp(((value - min) / span) * 100, 0, 100);
    var color = scoreColorName(gaussianScore(value, metric.ideal_low, metric.ideal_high));

    return '<div class="scale">' +
      '<div class="scale__track">' +
        '<div class="scale__ideal" style="left:' + fmt(idealLeft, 2) + "%;width:" +
          fmt(idealWidth, 2) + '%"></div>' +
        '<div class="scale__center" style="left:' + fmt(centerLeft, 2) + '%"></div>' +
        '<div class="scale__marker" style="left:' + fmt(markerLeft, 2) +
          "%;border-color:" + colorVar(color) + '"></div>' +
      "</div>" +
      '<div class="scale__labels">' +
        "<span>" + fmt(min, 2) + "</span>" +
        "<span>норма " + fmt(metric.ideal_low, 2) + "–" + fmt(metric.ideal_high, 2) + "</span>" +
        "<span>" + fmt(max, 2) + "</span>" +
      "</div>" +
    "</div>";
  }

  function metricRow(metric, onClick) {
    var row = document.createElement("button");
    row.type = "button";
    row.className = "ratio-row";
    row.innerHTML =
      '<span class="ratio-row__mark" style="background:' + colorVar(metric.color) + '"></span>' +
      '<span class="ratio-row__body">' +
        '<span class="ratio-row__name">' + metric.label + "</span>" +
        '<span class="ratio-row__meta">норма ' + fmt(metric.ideal_low, 2) + "–" +
          fmt(metric.ideal_high, 2) + " · " + metric.rating_ru + "</span>" +
      "</span>" +
      '<span class="ratio-row__right">' +
        '<span class="ratio-row__val">' + metric.display + "</span>" +
        '<span class="ratio-row__score ' + softClass(metric.color) + '">' +
          fmt(metric.score, 1) + "</span>" +
        '<span class="ratio-row__chev">›</span>' +
      "</span>";
    if (typeof onClick === "function") {
      row.addEventListener("click", function () {
        onClick(metric);
      });
    }
    return row;
  }

  var FACE_OVAL = [
    10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,
    378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,
    162,21,54,103,67,109
  ];

  var MIDLINE_PTS = [10, 151, 9, 168, 1, 2, 0, 17, 152];

  function drawLandmarks(canvas, photo, points, mode) {
    if (!canvas || !photo || !points || !points.length) {
      return;
    }
    var width = photo.clientWidth || 320;
    var height = photo.clientHeight || 420;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (mode === "off") {
      return;
    }

    if (mode === "mesh") {
      ctx.strokeStyle = "rgba(43, 184, 168, 0.15)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      var first = true;
      FACE_OVAL.forEach(function (idx) {
        var pt = points[idx];
        if (!pt) return;
        if (first) { ctx.moveTo(pt[0] * width, pt[1] * height); first = false; }
        else ctx.lineTo(pt[0] * width, pt[1] * height);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      var mTop = points[10], mBot = points[152];
      if (mTop && mBot) {
        ctx.strokeStyle = "rgba(43, 184, 168, 0.12)";
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(mTop[0] * width, mTop[1] * height);
        ctx.lineTo(mBot[0] * width, mBot[1] * height);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.fillStyle = "rgba(43, 184, 168, 0.7)";
      points.forEach(function (point) {
        ctx.beginPath();
        ctx.arc(point[0] * width, point[1] * height, 1.0, 0, Math.PI * 2);
        ctx.fill();
      });
      return;
    }

    var pairs = Array.isArray(mode) ? mode : [];
    ctx.strokeStyle = "rgba(21, 25, 29, 0.65)";
    ctx.lineWidth = 1.5;
    pairs.forEach(function (pair) {
      var a = points[pair[0]];
      var b = points[pair[1]];
      if (!a || !b) return;
      ctx.beginPath();
      ctx.moveTo(a[0] * width, a[1] * height);
      ctx.lineTo(b[0] * width, b[1] * height);
      ctx.stroke();
    });

    var pulseIndices = [];
    pairs.forEach(function (pair) {
      pair.forEach(function (idx) {
        if (pulseIndices.indexOf(idx) === -1) pulseIndices.push(idx);
      });
    });

    pulseIndices.forEach(function (idx) {
      var pt = points[idx];
      if (!pt) return;
      var px = pt[0] * width;
      var py = pt[1] * height;

      ctx.fillStyle = "rgba(43, 184, 168, 0.18)";
      ctx.beginPath();
      ctx.arc(px, py, 12, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(43, 184, 168, 0.9)";
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(px, py, 1.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function bindStickyHeader(report, options) {
    var opts = options || {};
    var thumb = $("stickyThumb");
    var title = $("stickyTitle");
    var sub = $("stickySub");
    var back = $("backBtn");

    var front = safeGet(STORAGE.front);
    if (thumb && front) {
      thumb.src = front;
    }
    if (title) {
      title.textContent = opts.title || "FACE LAB";
    }
    if (sub && report) {
      sub.textContent = opts.sub ||
        (GENDER_RU[report.gender] + " · " + ETH_RU[report.ethnicity]);
    }
    if (back) {
      back.addEventListener("click", function () {
        if (opts.backHref) {
          window.location.href = opts.backHref;
        } else if (window.history.length > 1) {
          window.history.back();
        } else {
          window.location.href = "/";
        }
      });
    }
  }

  function bindPhotoToggle(report, options) {
    var opts = options || {};
    var stagePhoto = $("stagePhoto");
    var canvas = $("stageCanvas");
    var toggle = $("photoToggle");
    if (!stagePhoto) {
      return;
    }

    var front = safeGet(STORAGE.front);
    var profile = safeGet(STORAGE.profile);
    var mode = "front";
    var overlayMode = opts.overlay || "mesh";

    function paint() {
      var source = mode === "front" ? front : profile;
      var empty = $("stageEmpty");
      if (!source) {
        stagePhoto.removeAttribute("src");
        if (empty) {
          empty.style.display = "grid";
          empty.textContent = mode === "front"
            ? "Кадр анфас недоступен"
            : "Профиль не загружен";
        }
        if (canvas) {
          var ctx = canvas.getContext("2d");
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        return;
      }
      if (empty) {
        empty.style.display = "none";
      }
      stagePhoto.src = source;
      stagePhoto.classList.add("photo-reveal");
      window.setTimeout(function () {
        stagePhoto.classList.add("is-visible");
      }, 80);
      stagePhoto.onload = function () {
        var lm = (mode === "profile" || mode === "side")
          ? (report && report.landmarks && report.landmarks.profile)
          : (report && report.landmarks && report.landmarks.front);
        if (lm && lm.length) {
          drawLandmarks(canvas, stagePhoto, lm, overlayMode);
        } else if (canvas) {
          var ctx = canvas.getContext("2d");
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      };
      if (stagePhoto.complete) {
        stagePhoto.onload();
      }
    }

    if (toggle) {
      qsa(".toggle__btn", toggle).forEach(function (button) {
        button.addEventListener("click", function () {
          mode = button.getAttribute("data-side");
          stagePhoto.classList.remove("is-visible");
          qsa(".toggle__btn", toggle).forEach(function (other) {
            other.classList.toggle("is-active", other === button);
          });
          window.setTimeout(paint, 80);
        });
      });
    }

    window.addEventListener("resize", function () {
      window.clearTimeout(window._flResize);
      window._flResize = window.setTimeout(paint, 180);
    });

    paint();
  }

  /* -------------------------------------------------------- animations */

  function countUp(el, target, duration, suffix) {
    if (!el) return;
    var start = performance.now();
    var from = 0;
    var dec = typeof target === "number" && target % 1 !== 0
      ? (String(target).split(".")[1] || "").length : 0;
    var sfx = suffix || "";

    function frame(now) {
      var t = Math.min((now - start) / (duration || 800), 1);
      var ease = 1 - Math.pow(1 - t, 3);
      var val = from + (target - from) * ease;
      el.textContent = val.toFixed(dec) + sfx;
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function staggerReveal(host, selector) {
    var children = qsa(selector, host);
    children.forEach(function (child, i) {
      child.style.opacity = "0";
      child.style.animationDelay = (i * 0.07 + 0.05) + "s";
      child.classList.add("stagger-child");
    });
  }

  function drawLandmarksPulse(canvas, photo, points, indices) {
    if (!canvas || !photo || !points || !indices) return;
    var width = photo.clientWidth || 320;
    var height = photo.clientHeight || 420;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(43, 184, 168, 0.12)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    var first = true;
    FACE_OVAL.forEach(function (idx) {
      var pt = points[idx];
      if (!pt) return;
      if (first) { ctx.moveTo(pt[0] * width, pt[1] * height); first = false; }
      else ctx.lineTo(pt[0] * width, pt[1] * height);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    indices.forEach(function (idx) {
      var pt = points[idx];
      if (!pt) return;
      var x = pt[0] * width;
      var y = pt[1] * height;

      ctx.fillStyle = "rgba(43, 184, 168, 0.18)";
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(43, 184, 168, 0.9)";
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  window.FaceLab = {
    STORAGE: STORAGE,
    GENDER_RU: GENDER_RU,
    ETH_RU: ETH_RU,
    CAT_ORDER: CAT_ORDER,
    CAT_RU: CAT_RU,
    $: $,
    qsa: qsa,
    clamp: clamp,
    fmt: fmt,
    colorVar: colorVar,
    softClass: softClass,
    scoreColorName: scoreColorName,
    scoreLabelRu: scoreLabelRu,
    gaussianScore: gaussianScore,
    loadReport: loadReport,
    category: category,
    queryParam: queryParam,
    toast: toast,
    showEmptyState: showEmptyState,
    buildScale: buildScale,
    metricRow: metricRow,
    drawLandmarks: drawLandmarks,
    bindStickyHeader: bindStickyHeader,
    bindPhotoToggle: bindPhotoToggle,
    safeGet: safeGet,
    safeSet: safeSet,
    countUp: countUp,
    staggerReveal: staggerReveal,
    drawLandmarksPulse: drawLandmarksPulse
  };
})();
