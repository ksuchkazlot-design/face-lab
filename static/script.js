/* ==========================================================================
   FACE LAB - main flow: setup -> upload -> analyse -> report
   ========================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------ telegram */
  var tgApp = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  var tgInitData = "";
  var tgUserId = 0;

  if (tgApp) {
    tgApp.ready();
    tgApp.expand();
    tgInitData = tgApp.initData || "";
    if (tgApp.initDataUnsafe && tgApp.initDataUnsafe.user) {
      tgUserId = tgApp.initDataUnsafe.user.id || 0;
    }
    tgApp.MainButton.hide();
  }

  function haptic(type) {
    try {
      if (tgApp && tgApp.HapticFeedback) {
        if (type === "light" || type === "medium" || type === "heavy") {
          tgApp.HapticFeedback.impactOccurred(type);
        } else if (type === "success" || type === "error" || type === "warning") {
          tgApp.HapticFeedback.notificationOccurred(type);
        } else if (type === "selection") {
          tgApp.HapticFeedback.selectionChanged();
        }
      }
    } catch (e) {}
  }

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

  var PRIMARY_CATS = ["harmony", "angularity", "dimorphism", "features"];
  var SECONDARY_CATS = ["skin", "hair"];

  var ANALYSIS_PAGE = {
    harmony: "/analysis/harmony.html",
    angularity: "/analysis/angularity.html",
    dimorphism: "/analysis/dimorphism.html",
    features: "/analysis/features.html",
    skin: "/analysis/skin.html",
    hair: "/analysis/hair.html"
  };

  var state = {
    step: 1,
    gender: null,
    ethnicity: null,
    frontFile: null,
    profileFile: null,
    frontData: null,
    profileData: null,
    analysis: null,
    view: "overview",
    overlay: "mesh",
    simKey: null,
    busy: false,
    progressTimer: null,
    progress: 0
  };

  /* ---------------------------------------------------------------- utils */

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
    }, 3200);
  }

  function animateCounter(el, start, end, decimals, duration, suffix) {
    if (!el) return;
    var startTime = null;
    var dur = duration || 480;
    var dec = typeof decimals === "number" ? decimals : 1;
    var suff = suffix || "";

    function step(timestamp) {
      if (!startTime) startTime = timestamp;
      var progress = Math.min((timestamp - startTime) / dur, 1);
      var ease = 1 - Math.pow(1 - progress, 3);
      var current = start + (end - start) * ease;
      el.textContent = current.toFixed(dec) + suff;
      if (progress < 1) {
        window.requestAnimationFrame(step);
      } else {
        el.textContent = end.toFixed(dec) + suff;
      }
    }
    window.requestAnimationFrame(step);
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result));
      };
      reader.onerror = function () {
        reject(new Error("Не удалось прочитать файл."));
      };
      reader.readAsDataURL(file);
    });
  }

  function shrinkDataUrl(dataUrl, maxSide, quality) {
    return new Promise(function (resolve) {
      var image = new Image();
      image.onload = function () {
        var w = image.naturalWidth;
        var h = image.naturalHeight;
        var longest = Math.max(w, h);
        var scale = longest > maxSide ? maxSide / longest : 1;
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        var ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        try {
          resolve(canvas.toDataURL("image/jpeg", quality || 0.72));
        } catch (error) {
          resolve(dataUrl);
        }
      };
      image.onerror = function () {
        resolve(dataUrl);
      };
      image.src = dataUrl;
    });
  }

  function safeSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  function safeGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  /* ------------------------------------------------------------ animations */

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

  function staggerReveal(host, selector, extraClass) {
    var children = qsa(selector, host);
    children.forEach(function (child, i) {
      child.style.opacity = "0";
      child.style.animationDelay = (i * 0.07 + 0.05) + "s";
      child.classList.add("stagger-child");
      if (extraClass) child.classList.add(extraClass);
    });
  }

  function createRipple(event) {
    var btn = event.currentTarget;
    var existing = btn.querySelector(".fl-ripple");
    if (existing) existing.remove();
    var ripple = document.createElement("span");
    ripple.className = "fl-ripple";
    var rect = btn.getBoundingClientRect();
    ripple.style.left = (event.clientX - rect.left) + "px";
    ripple.style.top = (event.clientY - rect.top) + "px";
    btn.appendChild(ripple);
    setTimeout(function () { ripple.remove(); }, 600);
  }

  function initMetricObserver() {
    if (!("IntersectionObserver" in window)) return;
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var fill = entry.target.querySelector(".cat-card__fill");
          if (fill && fill.style.width === "0%" || fill.style.width === "") {
            fill.style.width = entry.target.getAttribute("data-fill") || "0%";
          }
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.2 });
    qsa(".cat-card").forEach(function (card) {
      var fill = card.querySelector(".cat-card__fill");
      if (fill) {
        var targetWidth = fill.style.width || "0%";
        card.setAttribute("data-fill", targetWidth);
        fill.style.width = "0%";
        observer.observe(card);
      }
    });
  }

  function initLoaderParallax() {
    var orb = document.querySelector(".loader__orb");
    if (!orb) return;
    var rings = orb.querySelectorAll(".loader__ring");
    var maxShift = 5;

    document.addEventListener("mousemove", function (e) {
      var rect = orb.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var dx = (e.clientX - cx) / (window.innerWidth / 2);
      var dy = (e.clientY - cy) / (window.innerHeight / 2);
      rings.forEach(function (ring, i) {
        var depth = (i + 1) * 0.5;
        ring.style.transform =
          "translate(" + (dx * maxShift * depth) + "px," +
          (dy * maxShift * depth) + "px)";
      });
    });
  }

  /* ------------------------------------------------------------ step flow */

  function setStep(step) {
    state.step = step;
    [1, 2, 3, 4].forEach(function (n) {
      var section = $("step" + n);
      if (section) {
        section.classList.toggle("is-active", n === step);
      }
    });
    document.body.classList.toggle("is-step-4", step === 4);
    qsa("[data-seg]").forEach(function (seg) {
      seg.classList.toggle("is-done", Number(seg.getAttribute("data-seg")) <= step);
    });
    var label = $("stepsLabel");
    if (label) {
      label.textContent = "Шаг " + step + " из 4";
    }
    var bar = $("stepsBar");
    if (bar) {
      bar.setAttribute("aria-valuenow", String(step));
    }
    var tag = $("brandTag");
    if (tag) {
      tag.textContent = step === 4 ? "Отчёт готов" : "52 метрики";
    }
    updateCta();
    window.scrollTo({ top: 0, behavior: step === 1 ? "auto" : "smooth" });
  }

  function updateCta() {
    var cta = $("ctaBtn");
    var label = $("ctaLabel");
    var wrap = $("stickyCta");
    if (!cta || !label || !wrap) {
      return;
    }

    if (state.step === 3 || state.step === 4) {
      wrap.style.display = "none";
      return;
    }
    wrap.style.display = "";

    if (state.step === 1) {
      var ready = Boolean(state.gender && state.ethnicity);
      cta.disabled = !ready;
      label.textContent = ready ? "Далее — фотографии" : "Выберите пол и тип";
      return;
    }

    if (state.step === 2) {
      cta.disabled = !state.frontFile || state.busy;
      cta.classList.toggle("is-busy", state.busy);
      label.textContent = state.busy
        ? "Анализируем…"
        : state.frontFile
          ? "Запустить анализ"
          : "Нужно фото анфас";
      return;
    }

    if (state.step === 4) {
      cta.disabled = false;
      cta.classList.remove("is-busy");
      label.textContent = "Открыть все метрики";
    }
  }

  /* --------------------------------------------------------- step 1 logic */

  function bindChoices() {
    qsa("#genderGrid .choice").forEach(function (button) {
      button.addEventListener("click", function () {
        state.gender = button.getAttribute("data-gender");
        qsa("#genderGrid .choice").forEach(function (other) {
          other.setAttribute("aria-pressed", String(other === button));
        });
        updateCta();
        updateChoiceEcho();
      });
    });

    qsa("#ethnicityGrid .choice").forEach(function (button) {
      button.addEventListener("click", function () {
        state.ethnicity = button.getAttribute("data-ethnicity");
        qsa("#ethnicityGrid .choice").forEach(function (other) {
          other.setAttribute("aria-pressed", String(other === button));
        });
        updateCta();
        updateChoiceEcho();
      });
    });
  }

  function updateChoiceEcho() {
    var echo = $("choiceEcho");
    if (!echo) {
      return;
    }
    if (!state.gender || !state.ethnicity) {
      echo.textContent = "—";
      return;
    }
    echo.textContent = GENDER_RU[state.gender] + " · " + ETH_RU[state.ethnicity];
  }

  /* --------------------------------------------------------- step 2 logic */

  function bindDrop(kind) {
    var suffix = kind === "front" ? "Front" : "Profile";
    var drop = $("drop" + suffix);
    var input = $("file" + suffix);
    var preview = $("preview" + suffix);
    var clear = $("clear" + suffix);
    if (!drop || !input || !preview || !clear) {
      return;
    }

    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      if (!file) {
        return;
      }
      if (!/^image\//.test(file.type)) {
        toast("Нужен файл изображения.", true);
        input.value = "";
        return;
      }
      if (file.size > 18 * 1024 * 1024) {
        toast("Файл больше 18 МБ.", true);
        input.value = "";
        return;
      }
      readFileAsDataUrl(file).then(function (dataUrl) {
        preview.src = dataUrl;
        drop.classList.add("has-image");
        if (kind === "front") {
          state.frontFile = file;
          state.frontData = dataUrl;
        } else {
          state.profileFile = file;
          state.profileData = dataUrl;
        }
        updateCta();
      }).catch(function (error) {
        toast(error.message, true);
      });
    });

    clear.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      input.value = "";
      preview.removeAttribute("src");
      drop.classList.remove("has-image");
      if (kind === "front") {
        state.frontFile = null;
        state.frontData = null;
      } else {
        state.profileFile = null;
        state.profileData = null;
      }
      updateCta();
    });

    ["dragenter", "dragover"].forEach(function (name) {
      drop.addEventListener(name, function (event) {
        event.preventDefault();
        drop.classList.add("is-over");
      });
    });

    ["dragleave", "drop"].forEach(function (name) {
      drop.addEventListener(name, function (event) {
        event.preventDefault();
        drop.classList.remove("is-over");
      });
    });

    drop.addEventListener("drop", function (event) {
      var files = event.dataTransfer && event.dataTransfer.files;
      if (files && files.length) {
        input.files = files;
        var changeEvent = new Event("change");
        input.dispatchEvent(changeEvent);
      }
    });
  }

  /* ------------------------------------------------------ step 3 progress */

  var PHASES = [
    { at: 6, key: "upload", phase: "Отправляем кадры", hint: "Сжимаем и передаём на сервер" },
    { at: 26, key: "landmarks", phase: "Детекция точек", hint: "MediaPipe ищет 478 landmarks" },
    { at: 48, key: "geometry", phase: "Считаем геометрию", hint: "Углы, длины и пропорции" },
    { at: 66, key: "pixels", phase: "Кожа и волосы", hint: "Цвет, ровность и текстура" },
    { at: 82, key: "scoring", phase: "Сравниваем с референсом", hint: "Гауссова оценка по каждой метрике" },
    { at: 95, key: "report", phase: "Собираем отчёт", hint: "Почти готово" }
  ];

  function setProgress(value) {
    state.progress = clamp(value, 0, 100);
    var fill = $("progressFill");
    var pct = $("loaderPct");
    var bar = $("progressBar");
    if (fill) {
      fill.style.width = state.progress + "%";
    }
    if (pct) {
      pct.textContent = Math.round(state.progress) + "%";
    }
    if (bar) {
      bar.setAttribute("aria-valuenow", String(Math.round(state.progress)));
    }

    var active = PHASES[0];
    PHASES.forEach(function (phase) {
      if (state.progress >= phase.at) {
        active = phase;
      }
    });
    var phaseEl = $("loaderPhase");
    var hintEl = $("loaderHint");
    if (phaseEl) {
      phaseEl.textContent = active.phase;
    }
    if (hintEl) {
      hintEl.textContent = active.hint;
    }

    PHASES.forEach(function (phase) {
      var item = document.querySelector('[data-check="' + phase.key + '"]');
      if (item) {
        item.classList.toggle("is-done", state.progress > phase.at + 4);
      }
    });
  }

  function startProgress() {
    setProgress(3);
    window.clearInterval(state.progressTimer);
    state.progressTimer = window.setInterval(function () {
      var ceiling = 92;
      if (state.progress >= ceiling) {
        return;
      }
      var step = state.progress < 40 ? 2.4 : state.progress < 70 ? 1.5 : 0.7;
      setProgress(state.progress + step);
    }, 220);
  }

  function finishProgress() {
    window.clearInterval(state.progressTimer);
    state.progressTimer = null;
    setProgress(100);
  }

  function stopProgress() {
    window.clearInterval(state.progressTimer);
    state.progressTimer = null;
  }

  /* ------------------------------------------------------------ analysing */

  function runAnalysis() {
    if (state.busy || !state.frontFile) {
      return;
    }
    state.busy = true;
    setStep(3);
    startProgress();

    var form = new FormData();
    form.append("front", state.frontFile);
    if (state.profileFile) {
      form.append("profile", state.profileFile);
    }
    form.append("gender", state.gender);
    form.append("ethnicity", state.ethnicity);
    if (tgInitData) {
      form.append("initData", tgInitData);
    }

    window.fetch("/analyze-complete", { method: "POST", body: form })
      .then(function (response) {
        return response.json().then(function (payload) {
          if (response.status === 402) {
            // Payment required — show paywall
            throw { paywall: true, message: payload && payload.detail ? payload.detail : "Для анализа нужно оплатить пакет." };
          }
          if (!response.ok) {
            throw new Error(payload && payload.detail ? payload.detail : "Ошибка сервера.");
          }
          return payload;
        }).catch(function (error) {
          if (error && error.paywall) throw error;
          if (error instanceof SyntaxError) {
            throw new Error("Сервер вернул некорректный ответ.");
          }
          throw error;
        });
      })
      .then(function (payload) {
        state.analysis = payload;
        finishProgress();
        return persist(payload);
      })
      .then(function () {
        window.setTimeout(function () {
          state.busy = false;
          renderReport();
          setStep(4);
          initMetricObserver();
          var frontImg = $("resultFront");
          if (frontImg) frontImg.classList.add("photo-reveal");
          window.setTimeout(function () {
            if (frontImg) frontImg.classList.add("is-visible");
          }, 100);
        }, 420);
      })
      .catch(function (error) {
        stopProgress();
        state.busy = false;
        if (error && error.paywall) {
          showPaywall();
          return;
        }
        setStep(2);
        toast(error.message || "Не удалось выполнить анализ.", true);
      });
  }

  /* ------------------------------------------------------------ paywall */

  function showPaywall() {
    setStep(2);
    var overlay = $("paywallOverlay");
    if (overlay) {
      overlay.classList.add("is-visible");
    }
  }

  function hidePaywall() {
    var overlay = $("paywallOverlay");
    if (overlay) {
      overlay.classList.remove("is-visible");
    }
  }

  function persist(payload) {
    safeSet(STORAGE.gender, state.gender);
    safeSet(STORAGE.ethnicity, state.ethnicity);

    var slim = JSON.parse(JSON.stringify(payload));
    var stored = safeSet(STORAGE.analysis, JSON.stringify(slim));
    if (!stored) {
      delete slim.landmarks;
      delete slim.standards_used;
      safeSet(STORAGE.analysis, JSON.stringify(slim));
    }

    var jobs = [];
    if (state.frontData) {
      jobs.push(shrinkDataUrl(state.frontData, 720, 0.7).then(function (small) {
        if (!safeSet(STORAGE.front, small)) {
          return shrinkDataUrl(state.frontData, 460, 0.6).then(function (tiny) {
            safeSet(STORAGE.front, tiny);
          });
        }
        return null;
      }));
    } else {
      try {
        window.localStorage.removeItem(STORAGE.front);
      } catch (error) {
        toast("Локальное хранилище недоступно.", true);
      }
    }

    if (state.profileData) {
      jobs.push(shrinkDataUrl(state.profileData, 720, 0.7).then(function (small) {
        if (!safeSet(STORAGE.profile, small)) {
          return shrinkDataUrl(state.profileData, 460, 0.6).then(function (tiny) {
            safeSet(STORAGE.profile, tiny);
          });
        }
        return null;
      }));
    } else {
      try {
        window.localStorage.removeItem(STORAGE.profile);
      } catch (error) {
        return Promise.all(jobs);
      }
    }

    return Promise.all(jobs);
  }

  /* ------------------------------------------------------------- report UI */

  function catByKey(key) {
    var found = null;
    (state.analysis.categories || []).forEach(function (cat) {
      if (cat.key === key) {
        found = cat;
      }
    });
    return found;
  }

  function renderReport() {
    var data = state.analysis;
    if (!data) {
      return;
    }

    var overall = data.overall || { score: 0, color: "green", rating_ru: "—", percentile: 0 };
    $("overallScore").textContent = "0.0";
    countUp($("overallScore"), overall.score, 1000, "");
    $("overallRating").textContent = overall.rating_ru;
    $("overallPercentile").textContent = "0%";
    countUp($("overallPercentile"), overall.percentile, 1000, "%");
    $("overallNote").textContent =
      "Взвешенная оценка по " + (data.categories || []).length +
      " категориям и " + overall.metric_count + " метрикам.";

    var dial = $("dialValue");
    var circumference = 2 * Math.PI * 52;
    dial.setAttribute("stroke-dasharray", String(circumference));
    dial.setAttribute("stroke-dashoffset", String(circumference));
    dial.style.stroke = colorVar(overall.color);
    window.setTimeout(function () {
      dial.setAttribute("stroke-dashoffset",
        String(circumference * (1 - clamp(overall.score / 10, 0, 1))));
    }, 120);

    $("reportMeta").textContent =
      GENDER_RU[data.gender] + " · " + ETH_RU[data.ethnicity];

    renderPillarCards(data);
    renderTimeline(data);
    renderSecondary(data);
    renderPhotos();
    renderChart(data.chart);
    renderInsights(data);
    renderLooksmaxxing(data);
    renderTech(data);
    renderAnalysisGroups(data);
    renderPlan(data);
    initSimulate(data);
    renderOverlay();

    var heroScore = $("heroOverallScore");
    if (heroScore && data.overall) {
      animateCounter(heroScore, 0, data.overall.score, 2, 600, "");
    }
    var harmCat = catByKey("harmony");
    var heroCatScore = $("heroCatScore");
    if (heroCatScore && harmCat) {
      animateCounter(heroCatScore, 0, harmCat.score, 2, 500, " / 10");
    }

    var analysisPhoto = $("analysisPhotoStage");
    if (analysisPhoto && state.frontData) {
      analysisPhoto.src = state.frontData;
    }

    for (var h = 1; h <= 7; h++) {
      var ht = $("fiqHistThumb" + h);
      if (ht && state.frontData) {
        ht.src = state.frontData;
      }
    }
    var histScore = $("fiqHistScore1");
    if (histScore && data.overall) {
      histScore.textContent = fmt(data.overall.score, 1);
    }

    qsa("#fiqHistoryList .fiq-history-item").forEach(function (item) {
      item.addEventListener("click", function () {
        qsa("#fiqHistoryList .fiq-history-item").forEach(function (el) {
          el.classList.remove("is-active");
        });
        item.classList.add("is-active");
      });
    });
  }

  function renderPillarCards(data) {
    var host = $("pillarGrid");
    if (!host) return;
    host.innerHTML = "";

    var pillars = [
      { key: "harmony", idx: 0, bg: "pillar-bg-columns" },
      { key: "angularity", idx: 1, bg: "pillar-bg-statue" },
      { key: "dimorphism", idx: 2, bg: "pillar-bg-dna" },
      { key: "features", idx: 3, bg: "pillar-bg-features" }
    ];

    pillars.forEach(function (item) {
      var cat = catByKey(item.key);
      if (!cat) return;

      var isHarmony = item.key === "harmony";
      var card = document.createElement("div");
      card.className = "pillar-card " + item.bg;

      // 4 indicator bars where item.idx is active
      var barsHtml = "";
      for (var b = 0; b < 4; b++) {
        var isBarActive = b === item.idx;
        barsHtml += '<span class="pillar-indicator-bar' + (isBarActive ? ' is-active' : '') + '"></span>';
      }

      var btnClass = isHarmony ? "pillar-card__btn pillar-card__btn--teal" : "pillar-card__btn pillar-card__btn--dark";

      card.innerHTML =
        '<div class="pillar-card__head">' +
          '<div class="pillar-card__title-group">' +
            '<div class="pillar-indicator-bars">' + barsHtml + '</div>' +
            '<span class="pillar-card__title">' + cat.title + '</span>' +
          '</div>' +
          '<span class="pillar-card__arrow">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>' +
          '</span>' +
        '</div>' +
        '<div class="pillar-card__bg-score-wrap">' +
          '<span class="pillar-card__bg-score">' + fmt(cat.score, 2) + '</span>' +
          '<span class="pillar-card__bg-unit">/10</span>' +
        '</div>' +
        '<div class="pillar-card__btn-wrap">' +
          '<button type="button" class="' + btnClass + '">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>' +
            '<span>View ' + cat.title + ' Ratios</span>' +
          '</button>' +
        '</div>';

      var btn = card.querySelector(".pillar-card__btn");
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        currentAnalysisCat = item.key;
        qsa("#analysisCatTabs .fiq-pill-tab").forEach(function (b) {
          b.classList.toggle("is-active", b.getAttribute("data-cat") === item.key);
        });
        var tagEl = $("analysisPhotoTag");
        if (tagEl) tagEl.textContent = "Front " + cat.title;
        if (state.analysis) renderAnalysisGroups(state.analysis);
        setView("analysis");
      });
      card.addEventListener("click", function () {
        currentAnalysisCat = item.key;
        qsa("#analysisCatTabs .fiq-pill-tab").forEach(function (b) {
          b.classList.toggle("is-active", b.getAttribute("data-cat") === item.key);
        });
        var tagEl = $("analysisPhotoTag");
        if (tagEl) tagEl.textContent = "Front " + cat.title;
        if (state.analysis) renderAnalysisGroups(state.analysis);
        setView("analysis");
      });

      host.appendChild(card);
    });
  }

  function renderTimeline(data) {
    var host = $("timeline");
    host.innerHTML = "";

    PRIMARY_CATS.forEach(function (key) {
      var cat = catByKey(key);
      if (!cat) {
        return;
      }

      var node = document.createElement("div");
      node.className = "timeline__node";

      var dot = document.createElement("span");
      dot.className = "timeline__dot is-" + cat.color;
      node.appendChild(dot);

      var card = document.createElement("button");
      card.type = "button";
      card.className = "cat-card";
      card.setAttribute("aria-label", cat.title + ", " + fmt(cat.score, 1) + " из 10");

      var strengthCount = (cat.strengths || []).length;
      var improveCount = (cat.improvements || []).length;

      card.innerHTML =
        '<div class="cat-card__head">' +
          '<span class="cat-card__glyph" aria-hidden="true">' + cat.icon + "</span>" +
          "<div>" +
            '<div class="cat-card__name">' + cat.title + "</div>" +
            '<div class="cat-card__ru">' + cat.title_ru + "</div>" +
          "</div>" +
          '<div class="cat-card__score">' +
            '<div class="cat-card__value">' + fmt(cat.score, 1) +
              '<span class="cat-card__of"> / 10</span></div>' +
            '<div class="cat-card__rating">' + cat.rating_ru + "</div>" +
          "</div>" +
        "</div>" +
        '<div class="cat-card__bar"><span class="cat-card__fill"></span></div>' +
        '<div class="cat-card__foot">' +
          "<span>" + cat.metric_count + " метрик · " + strengthCount + " сильных · " +
            improveCount + " к работе</span>" +
          '<span class="cat-card__chevron">›</span>' +
        "</div>";

      var fill = card.querySelector(".cat-card__fill");
      fill.style.background = colorVar(cat.color);
      window.setTimeout(function () {
        fill.style.width = clamp(cat.score * 10, 0, 100) + "%";
      }, 160);

      card.querySelector(".cat-card__value").style.color = colorVar(cat.color);

      card.addEventListener("click", function () {
        window.location.href = ANALYSIS_PAGE[cat.key];
      });

      node.appendChild(card);
      host.appendChild(node);
    });

    staggerReveal(host, ".timeline__node");
  }

  function renderSecondary(data) {
    var host = $("secondaryCats");
    host.innerHTML = "";

    SECONDARY_CATS.forEach(function (key) {
      var cat = catByKey(key);
      if (!cat) {
        return;
      }
      var card = document.createElement("button");
      card.type = "button";
      card.className = "cat-card";
      card.innerHTML =
        '<div class="cat-card__head">' +
          '<span class="cat-card__glyph" aria-hidden="true">' + cat.icon + "</span>" +
          "<div>" +
            '<div class="cat-card__name">' + cat.title + "</div>" +
            '<div class="cat-card__ru">' + cat.title_ru + "</div>" +
          "</div>" +
          '<div class="cat-card__score">' +
            '<div class="cat-card__value">' + fmt(cat.score, 1) +
              '<span class="cat-card__of"> / 10</span></div>' +
            '<div class="cat-card__rating">' + cat.rating_ru + "</div>" +
          "</div>" +
        "</div>" +
        '<div class="cat-card__bar"><span class="cat-card__fill"></span></div>' +
        '<div class="cat-card__foot"><span>' + cat.metric_count +
          ' метрик</span><span class="cat-card__chevron">›</span></div>';

      var fill = card.querySelector(".cat-card__fill");
      fill.style.background = colorVar(cat.color);
      window.setTimeout(function () {
        fill.style.width = clamp(cat.score * 10, 0, 100) + "%";
      }, 200);
      card.querySelector(".cat-card__value").style.color = colorVar(cat.color);

      card.addEventListener("click", function () {
        window.location.href = ANALYSIS_PAGE[cat.key];
      });
      host.appendChild(card);
    });

    staggerReveal(host, ".cat-card");
  }

  function renderPhotos() {
    var front = state.frontData || safeGet(STORAGE.front);
    var profile = state.profileData || safeGet(STORAGE.profile);

    var frontImg = $("resultFront");
    var frontEmpty = $("resultFrontEmpty");
    if (front) {
      frontImg.src = front;
      frontEmpty.style.display = "none";
    } else {
      frontEmpty.style.display = "grid";
    }

    var profileImg = $("resultProfile");
    var profileEmpty = $("resultProfileEmpty");
    if (profile) {
      profileImg.src = profile;
      profileEmpty.style.display = "none";
    } else {
      profileEmpty.style.display = "grid";
    }

    var meta = $("photoMeta");
    meta.textContent = profile ? "анфас + профиль" : "только анфас";

    var stagePhoto = $("landmarkPhoto");
    if (front) {
      stagePhoto.src = front;
      stagePhoto.onload = renderOverlay;
    }
  }

  function renderChart(chart) {
    if (!chart) {
      return;
    }
    var width = 320;
    var height = 150;
    var baseline = 132;
    var top = 14;

    var points = chart.points || [];
    if (!points.length) {
      return;
    }

    var path = "M 0 " + baseline;
    points.forEach(function (point) {
      var x = (point.x / 10) * width;
      var y = baseline - point.y * (baseline - top);
      path += " L " + fmt(x, 2) + " " + fmt(y, 2);
    });
    path += " L " + width + " " + baseline + " Z";
    $("gaussCurve").setAttribute("d", path);

    var curveEl = $("gaussCurve");
    var len = curveEl.getTotalLength ? curveEl.getTotalLength() : 800;
    curveEl.style.strokeDasharray = len;
    curveEl.style.strokeDashoffset = len;
    window.setTimeout(function () {
      curveEl.style.transition = "stroke-dashoffset 1.2s cubic-bezier(0.22,0.61,0.36,1)";
      curveEl.style.strokeDashoffset = "0";
    }, 200);

    var userX = (clamp(chart.user_x, 0, 10) / 10) * width;
    var userY = baseline - chart.user_y * (baseline - top);
    var line = $("gaussLine");
    line.setAttribute("x1", fmt(userX, 2));
    line.setAttribute("x2", fmt(userX, 2));
    line.setAttribute("y1", fmt(userY, 2));
    line.setAttribute("y2", String(baseline));

    var dot = $("gaussDot");
    dot.setAttribute("cx", fmt(userX, 2));
    dot.setAttribute("cy", fmt(userY, 2));

    $("chartCallout").textContent =
      "Вы выше " + chart.percentile + "% выборки · оценка " + fmt(chart.user_x, 1);
  }

  var strengthsExpanded = false;
  var improvementsExpanded = false;
  var strengthsFilterCat = "all";
  var improvementsFilterCat = "all";

  function renderInsights(data) {
    var strengths = $("strengthsList");
    var improvements = $("improvementsList");
    if (!strengths || !improvements) return;
    strengths.innerHTML = "";
    improvements.innerHTML = "";

    var allStrengths = [];
    var allImprovements = [];
    (data.category_order || []).forEach(function (catKey) {
      var cat = catByKey(catKey);
      if (!cat) return;
      (cat.metrics || []).forEach(function (metric) {
        if (metric.score >= 7.0) {
          allStrengths.push(metric);
        } else {
          allImprovements.push(metric);
        }
      });
    });

    allStrengths.sort(function (a, b) { return b.score - a.score; });
    allImprovements.sort(function (a, b) { return a.score - b.score; });

    var filteredStrengths = allStrengths.filter(function (m) {
      return strengthsFilterCat === "all" || m.category === strengthsFilterCat;
    });
    var filteredImprovements = allImprovements.filter(function (m) {
      return improvementsFilterCat === "all" || m.category === improvementsFilterCat;
    });

    var sBadge = $("strengthsBadge");
    if (sBadge) sBadge.textContent = filteredStrengths.length + " features";
    var iBadge = $("improvementsBadge");
    if (iBadge) iBadge.textContent = filteredImprovements.length + " areas";

    var sLimit = strengthsExpanded ? filteredStrengths.length : Math.min(3, filteredStrengths.length);
    filteredStrengths.slice(0, sLimit).forEach(function (item) {
      var li = document.createElement("li");
      li.className = "feature-item";
      li.innerHTML =
        '<div class="feature-item__left">' +
          '<span class="tag-badge tag-badge--ideal">IDEAL</span>' +
          '<span class="feature-item__name">' + item.label + '</span>' +
        '</div>' +
        '<div class="feature-item__score">' +
          '<span>' + fmt(item.score, 1) + '</span>' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
        '</div>';
      li.addEventListener("click", function () {
        openRatioModal(item.key);
      });
      strengths.appendChild(li);
    });

    var sBtn = $("showMoreStrengthsBtn");
    if (sBtn) {
      var remainingS = filteredStrengths.length - 3;
      if (remainingS > 0) {
        sBtn.style.display = "";
        sBtn.textContent = strengthsExpanded ? "Show Less ∧" : "Show " + remainingS + " More ∨";
      } else {
        sBtn.style.display = "none";
      }
    }

    var iLimit = improvementsExpanded ? filteredImprovements.length : Math.min(3, filteredImprovements.length);
    filteredImprovements.slice(0, iLimit).forEach(function (item) {
      var li = document.createElement("li");
      li.className = "feature-item";
      var tagClass = item.score < 5.0 ? "tag-badge--severe" : "tag-badge--moderate";
      var tagText = item.score < 5.0 ? "SEVERE" : "MODERATE";
      var diff = item.score - 10.0;
      li.innerHTML =
        '<div class="feature-item__left">' +
          '<span class="tag-badge ' + tagClass + '">' + tagText + '</span>' +
          '<span class="feature-item__name">' + item.label + '</span>' +
        '</div>' +
        '<div class="feature-item__score feature-item__score--negative">' +
          '<span>' + (diff >= 0 ? "+" : "") + fmt(diff, 2) + '</span>' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
        '</div>';
      li.addEventListener("click", function () {
        openRatioModal(item.key);
      });
      improvements.appendChild(li);
    });

    var iBtn = $("showMoreImprovementsBtn");
    if (iBtn) {
      var remainingI = filteredImprovements.length - 3;
      if (remainingI > 0) {
        iBtn.style.display = "";
        iBtn.textContent = improvementsExpanded ? "Show Less ∧" : "Show " + remainingI + " More ∨";
      } else {
        iBtn.style.display = "none";
      }
    }
  }

  function renderLooksmaxxing(data) {
    var lm = data.looksmaxxing;
    if (!lm) {
      return;
    }
    var card = $("looksmaxCard");
    if (!card) return;

    var tierBadge = $("looksmaxTierBadge");
    if (tierBadge) {
      tierBadge.textContent = lm.tier || (data.overall && data.overall.rating_ru) || "HTN";
      tierBadge.style.color = colorVar(data.overall.color);
      tierBadge.style.borderColor = colorVar(data.overall.color);
    }

    var pslVal = $("looksmaxPslScore");
    if (pslVal) {
      pslVal.innerHTML = fmt(lm.psl_score, 1) + '<small>/8</small>';
    }

    var curVal = $("looksmaxCurrentScore");
    if (curVal) {
      curVal.innerHTML = fmt(lm.overall_score || data.overall.score, 1) + '<small>/10</small>';
    }

    var potVal = $("looksmaxPotentialScore");
    if (potVal) {
      potVal.innerHTML = fmt(lm.potential_score, 1) + '<small>/10</small>';
    }

    // Archetypes
    var archGrid = $("looksmaxArchetypesGrid");
    if (archGrid && lm.archetypes) {
      archGrid.innerHTML = "";
      Object.keys(lm.archetypes).forEach(function (key) {
        var item = lm.archetypes[key];
        var div = document.createElement("div");
        div.className = "looksmax-arch-item";
        div.innerHTML =
          '<span class="looksmax-arch-badge">' + item.badge + '</span>' +
          '<p class="looksmax-arch-desc">' + item.desc + '</p>';
        archGrid.appendChild(div);
      });
    }

    // Softmaxxing
    var softList = $("looksmaxSoftmaxList");
    if (softList && lm.softmaxxing) {
      softList.innerHTML = "";
      lm.softmaxxing.forEach(function (item) {
        var div = document.createElement("div");
        div.className = "looksmax-proto-item";
        div.innerHTML =
          '<div class="looksmax-proto-title">' + (item.title || "Протокол") + '</div>' +
          '<p class="looksmax-proto-action">' + (item.action || item) + '</p>';
        softList.appendChild(div);
      });
    }

    // Hardmaxxing
    var hardList = $("looksmaxHardmaxList");
    if (hardList && lm.hardmaxxing) {
      hardList.innerHTML = "";
      lm.hardmaxxing.forEach(function (tip) {
        var div = document.createElement("div");
        div.className = "looksmax-hard-item";
        div.textContent = tip;
        hardList.appendChild(div);
      });
    }
  }

  function renderTech(data) {
    $("techLandmarks").textContent = data.landmark_count + " / 478";
    $("techMetrics").textContent = String(data.overall.metric_count);
    $("techProfile").textContent = data.profile_used ? "да" : "нет";
    $("techElapsed").textContent = data.elapsed_ms + " мс";
    $("techStandard").textContent =
      GENDER_RU[data.gender] + " / " + ETH_RU[data.ethnicity];
  }

  /* ------------------------------------------------------- analysis groups */

  function metricRow(metric) {
    var row = document.createElement("button");
    row.type = "button";
    row.className = "ratio-table-row";

    var min = metric.scale_min;
    var max = metric.scale_max;
    var ratio = (metric.value - min) / Math.max(max - min, 1e-6);
    var dotPct = clamp(ratio * 100, 5, 95);

    row.innerHTML =
      '<div class="ratio-table-row__info">' +
        '<span class="ratio-row__mark" style="background:' + colorVar(metric.color) + '"></span>' +
        '<span class="ratio-table-row__name">' + metric.label + '</span>' +
        '<span class="ratio-table-row__val-pill">' + metric.display + '</span>' +
      '</div>' +
      '<div class="ratio-mini-bar">' +
        '<span class="ratio-mini-bar__dot" style="left:' + dotPct + '%;"></span>' +
      '</div>' +
      '<div class="ratio-table-row__score">' +
        '<span style="color:' + colorVar(metric.color) + '">' + fmt(metric.score, 1) + '</span>' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
      '</div>';

    row.addEventListener("click", function () {
      openRatioModal(metric.key);
    });
    return row;
  }

  var currentAnalysisCat = "harmony";

  function renderAnalysisGroups(data) {
    var host = $("analysisGroups");
    if (!host) return;
    host.innerHTML = "";

    var toggleSide = $("analysisToggleSide");
    var isSideMode = toggleSide && toggleSide.classList.contains("is-active");

    var titleEl = $("analysisPanelTitle");
    var badgeEl = $("analysisPanelBadge");

    if (isSideMode) {
      if (titleEl) titleEl.textContent = "Your Side Ratios";
      var sideKeys = [
        "gonial_angle", "ramus_ratio", "chin_projection",
        "mandible_definition", "jaw_mass", "chin_width_ratio",
        "nasal_index", "nose_length", "philtrum_length",
        "brow_ridge", "lower_third", "facial_thirds_balance"
      ];
      var sideMetrics = [];
      sideKeys.forEach(function (k) {
        if (data.metrics && data.metrics[k]) {
          sideMetrics.push(data.metrics[k]);
        }
      });
      if (badgeEl) badgeEl.textContent = sideMetrics.length + " ratios";
      sideMetrics.forEach(function (metric) {
        host.appendChild(metricRow(metric));
      });
    } else {
      var cat = catByKey(currentAnalysisCat) || catByKey("harmony");
      if (!cat) return;
      if (titleEl) titleEl.textContent = "Your Front Ratios";
      var metrics = (cat.metrics || []).slice();
      if (badgeEl) badgeEl.textContent = metrics.length + " ratios";
      metrics.forEach(function (metric) {
        host.appendChild(metricRow(metric));
      });
    }

    renderAnalysisStageOverlay();
  }

  /* -------------------------------------------------------------------------
     RATIO DETAIL MODAL & OVERLAY ENGINE (Matching Reference Screenshots 1-5)
     ------------------------------------------------------------------------- */

  var METRIC_OVERLAY = {
    canthal_tilt: [[33, 133], [263, 362]],
    lower_third: [[2, 152]],
    eye_separation: [[33, 133], [263, 362], [234, 454]],
    mouth_nose_ratio: [[61, 291], [129, 358]],
    facial_thirds_balance: [[10, 105], [105, 2], [2, 152]],
    vertical_symmetry: [[10, 152], [33, 263], [61, 291]],
    horizontal_symmetry: [[33, 263], [61, 291], [132, 288]],
    golden_ratio: [[10, 152], [234, 454]],
    midface_ratio: [[33, 263], [2, 152]],
    face_length_ratio: [[10, 152], [234, 454]],
    interocular_ratio: [[133, 362], [33, 133]],
    eye_spacing_symmetry: [[10, 152], [33, 133], [263, 362]],

    gonial_angle: [[127, 172], [172, 152], [356, 397], [397, 152]],
    cheekbone_prominence: [[234, 454], [127, 356]],
    jaw_cheek_ratio: [[172, 397], [234, 454]],
    jaw_frontal_angle: [[172, 152], [397, 152]],
    chin_width_ratio: [[148, 377], [172, 397]],
    mandible_definition: [[172, 397], [172, 152], [397, 152]],
    ramus_ratio: [[127, 172], [172, 152]],
    bigonial_width: [[172, 397], [10, 152]],
    chin_projection: [[9, 2], [2, 152]],
    jaw_mass: [[172, 397], [2, 152]],

    brow_ridge: [[105, 159], [334, 386]],
    lip_thickness: [[0, 13], [14, 17], [61, 291]],
    dimorphism_index: [[105, 334], [132, 288], [0, 17]],
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

  var modalState = {
    isOpen: false,
    key: null,
    overlayVisible: true,
    tab: "overview"
  };

  function getAllMetricKeys(data) {
    if (!data) return [];
    if (data.metrics) return Object.keys(data.metrics);
    var keys = [];
    (data.categories || []).forEach(function (cat) {
      (cat.metrics || []).forEach(function (m) {
        keys.push(m.key);
      });
    });
    return keys;
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

    var userX = clamp(toX(val), padding.left + 8, width - padding.right - 8);
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
      '<circle cx="' + userX.toFixed(1) + '" cy="' + userY.toFixed(1) + '" r="8" fill="none" stroke="#2BB8A8" stroke-width="2" style="animation: markerPulseRing 2s infinite ease-out;" />' +
      '<circle cx="' + userX.toFixed(1) + '" cy="' + userY.toFixed(1) + '" r="5" fill="#2BB8A8" stroke="#111827" stroke-width="2" />' +
      '<rect x="' + (userX - 24).toFixed(1) + '" y="' + Math.max(userY - 20, 2).toFixed(1) + '" width="48" height="15" rx="4" fill="#111827" />' +
      '<text x="' + userX.toFixed(1) + '" y="' + (Math.max(userY - 20, 2) + 11).toFixed(1) + '" text-anchor="middle" fill="#ffffff" font-size="9.5" font-weight="700">' + metric.display + '</text>' +
      '<text x="' + padding.left + '" y="' + (height - 6) + '" fill="#9ca3af" font-size="9">' + fmt(min, 1) + '</text>' +
      '<text x="' + toX(center).toFixed(1) + '" y="' + (height - 6) + '" text-anchor="middle" fill="#2BB8A8" font-size="9" font-weight="600">' + fmt(center, 1) + '</text>' +
      '<text x="' + (width - padding.right) + '" y="' + (height - 6) + '" text-anchor="end" fill="#9ca3af" font-size="9">' + fmt(max, 1) + '</text>' +
    '</svg>';
  }

  function drawModalOverlay(canvas, photo, metric, landmarksData, isVisible, isProfileParam) {
    if (!canvas || !photo) return;
    var ctx = canvas.getContext("2d");
    if (!ctx) return;

    var parent = canvas.parentElement;
    var width = canvas.clientWidth || (parent ? parent.clientWidth : 0) || 400;
    var height = canvas.clientHeight || (parent ? parent.clientHeight : 0) || 400;
    var dpr = window.devicePixelRatio || 1;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (!isVisible || !landmarksData) return;

    var isProfile = typeof isProfileParam === "boolean"
      ? isProfileParam
      : (metric && (metric.source === "profile" || metric.key === "ramus_ratio" || metric.key === "chin_projection"));
    var pts = null;
    if (landmarksData.front && Array.isArray(landmarksData.front)) {
      pts = (isProfile && landmarksData.profile && landmarksData.profile.length)
        ? landmarksData.profile
        : landmarksData.front;
    } else if (Array.isArray(landmarksData)) {
      pts = landmarksData;
    }

    if (!pts || !pts.length) return;

    var imgW = photo.naturalWidth || photo.width || width;
    var imgH = photo.naturalHeight || photo.height || height;
    var scale = Math.max(width / imgW, height / imgH);
    var renderW = imgW * scale;
    var renderH = imgH * scale;
    var offsetX = (width - renderW) / 2;
    var offsetY = (height - renderH) / 2;

    function pt(idx) {
      if (!pts[idx]) return [width * 0.5, height * 0.5];
      var nx = pts[idx][0];
      var ny = pts[idx][1];
      return [
        Math.round(offsetX + nx * renderW),
        Math.round(offsetY + ny * renderH)
      ];
    }

    ctx.save();
    var key = metric ? metric.key : "";
    var cyan = "#1bb49f";
    var cyanGlow = "rgba(27, 180, 159, 0.4)";
    var white = "rgba(255, 255, 255, 0.95)";

    function drawBadge(x, y, text) {
      ctx.save();
      ctx.font = "bold 12px Inter, -apple-system, sans-serif";
      var tw = ctx.measureText(text).width;
      var pw = tw + 16;
      var ph = 22;
      var px = x - pw / 2;
      var py = y - ph / 2;

      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
      ctx.shadowBlur = 8;
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(px, py, pw, ph, 6);
      } else {
        ctx.rect(px, py, pw, ph);
      }
      ctx.fill();

      ctx.strokeStyle = "rgba(27, 180, 159, 0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x, y);
      ctx.restore();
    }

    function drawDot(p, isHighlight) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(p[0], p[1], isHighlight ? 5.5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = isHighlight ? "#2dd4bf" : "#ffffff";
      ctx.shadowColor = cyanGlow;
      ctx.shadowBlur = 6;
      ctx.fill();

      ctx.lineWidth = 1.8;
      ctx.strokeStyle = "#0f172a";
      ctx.stroke();
      ctx.restore();
    }

    // 1. ANGLES: Gonial, Frontal Jaw, Chin Projection, Brow Tilt
    if (key === "gonial_angle" || key === "jaw_frontal_angle" || key === "chin_projection" || key === "brow_tilt" || key.indexOf("angle") !== -1) {
      var p1, vertex, p2;
      if (key === "gonial_angle") {
        // Gonial Angle vertex is at the Gonion (jaw angle corner)
        p1 = pt(127); // upper ramus / condyle
        vertex = pt(172); // gonion
        p2 = pt(152); // menton / chin
      } else if (key === "jaw_frontal_angle") {
        // Jaw Frontal Angle vertex is at the Chin (menton)
        p1 = pt(172); vertex = pt(152); p2 = pt(397);
      } else if (key === "chin_projection") {
        p1 = pt(9); vertex = pt(2); p2 = pt(152);
      } else {
        p1 = pt(55); vertex = pt(46); p2 = pt(276);
      }

      // Arms
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = cyan;
      ctx.shadowColor = cyanGlow;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(p1[0], p1[1]);
      ctx.lineTo(vertex[0], vertex[1]);
      ctx.lineTo(p2[0], p2[1]);
      ctx.stroke();

      // Angle Arc
      var a1 = Math.atan2(p1[1] - vertex[1], p1[0] - vertex[0]);
      var a2 = Math.atan2(p2[1] - vertex[1], p2[0] - vertex[0]);
      var arcR = 32;

      ctx.fillStyle = "rgba(27, 180, 159, 0.22)";
      ctx.beginPath();
      ctx.moveTo(vertex[0], vertex[1]);
      ctx.arc(vertex[0], vertex[1], arcR, a1, a2, false);
      ctx.closePath();
      ctx.fill();

      ctx.lineWidth = 2;
      ctx.strokeStyle = cyan;
      ctx.beginPath();
      ctx.arc(vertex[0], vertex[1], arcR, a1, a2, false);
      ctx.stroke();

      [p1, vertex, p2].forEach(function (p, i) { drawDot(p, i === 1); });

      var midA = (a1 + a2) / 2;
      var textX = vertex[0] + Math.cos(midA) * 52;
      var textY = vertex[1] + Math.sin(midA) * 52;
      drawBadge(textX, textY, metric.display);

    } else if (key === "ramus_ratio") {
      var condyle = pt(127);
      var gonion = pt(172);
      var menton = pt(152);

      // Highlighted vertical ramus
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = cyan;
      ctx.shadowColor = cyanGlow;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(condyle[0], condyle[1]);
      ctx.lineTo(gonion[0], gonion[1]);
      ctx.stroke();

      // Mandibular body line
      ctx.lineWidth = 2.0;
      ctx.strokeStyle = white;
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.moveTo(gonion[0], gonion[1]);
      ctx.lineTo(menton[0], menton[1]);
      ctx.stroke();

      [condyle, gonion, menton].forEach(function (p, i) { drawDot(p, i === 1); });

      var badgeX = (condyle[0] + gonion[0]) / 2 + (isProfile ? 28 : -28);
      var badgeY = (condyle[1] + gonion[1]) / 2;
      drawBadge(badgeX, badgeY, metric.display);

    } else if (key === "canthal_tilt") {
      // Left eye
      var li = pt(133), lo = pt(33);
      // Right eye
      var ri = pt(362), ro = pt(263);

      ctx.lineWidth = 2.4;
      ctx.strokeStyle = cyan;
      ctx.shadowColor = cyanGlow;
      ctx.shadowBlur = 8;

      // Eye axis lines
      [ [li, lo], [ri, ro] ].forEach(function (pair) {
        ctx.beginPath();
        ctx.moveTo(pair[0][0], pair[0][1]);
        ctx.lineTo(pair[1][0], pair[1][1]);
        ctx.stroke();
      });

      // Horizontal reference dashed lines
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
      ctx.beginPath();
      ctx.moveTo(lo[0] - 20, li[1]);
      ctx.lineTo(lo[0] + 15, li[1]);
      ctx.moveTo(ro[0] - 15, ri[1]);
      ctx.lineTo(ro[0] + 20, ri[1]);
      ctx.stroke();
      ctx.setLineDash([]);

      [li, lo, ri, ro].forEach(function (p) { drawDot(p, false); });

      var midX = (li[0] + lo[0]) / 2;
      var midY = (li[1] + lo[1]) / 2 - 18;
      drawBadge(midX, midY, metric.display);

    } else if (key === "facial_thirds_balance" || key === "lower_third" || key === "midface_ratio") {
      var topPt = pt(10);  // Trichion (top hairline midline)
      var browPt = pt(9);   // Glabella (midline between eyebrows! NOT 105!)
      var subPt = pt(2);    // Subnasale (base of nose midline)
      var chinPt = pt(152); // Menton (chin tip midline)

      var midX = topPt[0];

      // Central vertical midline
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = cyan;
      ctx.shadowColor = cyanGlow;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(midX, topPt[1]);
      ctx.lineTo(midX, chinPt[1]);
      ctx.stroke();

      // Horizontal dividers centered on midX
      var wSpan = width * 0.35;
      [topPt, browPt, subPt, chinPt].forEach(function (p) {
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = white;
        ctx.beginPath();
        ctx.moveTo(midX - wSpan, p[1]);
        ctx.lineTo(midX + wSpan, p[1]);
        ctx.stroke();
        drawDot([midX, p[1]], true);
      });

      var badgeX = midX + wSpan - 20;
      if (key === "facial_thirds_balance") {
        drawBadge(badgeX, (topPt[1] + browPt[1]) / 2, "33.3%");
        drawBadge(badgeX, (browPt[1] + subPt[1]) / 2, "33.3%");
        drawBadge(badgeX, (subPt[1] + chinPt[1]) / 2, "33.4%");
      } else if (key === "lower_third") {
        // Lower third: highlight the segment between subnasale and menton
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = cyan;
        ctx.beginPath();
        ctx.moveTo(midX, subPt[1]);
        ctx.lineTo(midX, chinPt[1]);
        ctx.stroke();
        drawBadge(badgeX, (subPt[1] + chinPt[1]) / 2, metric.display);
      } else {
        drawBadge(badgeX, (browPt[1] + subPt[1]) / 2, metric.display);
      }

    } else if (key === "vertical_symmetry" || key === "horizontal_symmetry") {
      var topPt = pt(10), chinPt = pt(152);

      // Vertical midline
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = cyan;
      ctx.shadowColor = cyanGlow;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(topPt[0], topPt[1]);
      ctx.lineTo(chinPt[0], chinPt[1]);
      ctx.stroke();

      // Horizontal symmetry checks
      var pairsSym = [ [33, 263], [129, 358], [61, 291], [172, 397] ];
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
      pairsSym.forEach(function (pair) {
        var a = pt(pair[0]), b = pt(pair[1]);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
        drawDot(a, false);
        drawDot(b, false);
      });

      drawDot(topPt, true);
      drawDot(chinPt, true);
      drawBadge(topPt[0], chinPt[1] - 26, metric.display);

    } else if (key.indexOf("skin") !== -1 || key === "undereye_darkness") {
      // Highlight skin inspection zones
      var zones = [
        { p: pt(205), r: 24, label: "Left Cheek" },
        { p: pt(425), r: 24, label: "Right Cheek" },
        { p: pt(151), r: 22, label: "Forehead" },
        { p: pt(111), r: 16, label: "Under-eye L" },
        { p: pt(340), r: 16, label: "Under-eye R" }
      ];

      zones.forEach(function (z) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = cyan;
        ctx.shadowColor = cyanGlow;
        ctx.shadowBlur = 8;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(z.p[0], z.p[1], z.r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(27, 180, 159, 0.16)";
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
        drawDot(z.p, false);
      });

      drawBadge(pt(205)[0], pt(205)[1] - 34, metric.display);

    } else {
      // General paired metrics
      var pairs = METRIC_OVERLAY[key] || [[33, 133], [263, 362]];
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = cyan;
      ctx.shadowColor = cyanGlow;
      ctx.shadowBlur = 8;

      var lastMid = [width * 0.5, height * 0.5];

      pairs.forEach(function (pair) {
        var a = pt(pair[0]);
        var b = pt(pair[1]);

        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();

        drawDot(a, false);
        drawDot(b, false);

        lastMid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      });

      drawBadge(lastMid[0], lastMid[1] - 16, metric.display);
    }

    ctx.restore();
  }

  function renderAnalysisStageOverlay() {
    var canvas = $("analysisCanvasStage");
    var photo = $("analysisPhotoStage");
    if (!canvas || !photo) return;

    var width = photo.clientWidth || 380;
    var height = photo.clientHeight || 500;
    if (width <= 0 || height <= 0) return;

    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";

    var ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
    }
  }

  function openRatioModal(metricKey) {
    if (!state.analysis || !state.analysis.metrics) return;
    var metric = state.analysis.metrics[metricKey];
    if (!metric) return;

    modalState.isOpen = true;
    modalState.key = metricKey;
    modalState.tab = "overview";

    var overlay = $("ratioModalOverlay");
    if (overlay) {
      overlay.classList.add("is-open");
      overlay.setAttribute("aria-hidden", "false");
    }

    renderRatioModal(metricKey);

    var isProfileMetric = metric.source === "profile" ||
      metric.key === "ramus_ratio" ||
      metric.key === "chin_projection" ||
      (metric.key === "gonial_angle" && !!state.profileData);
    var isProfile = isProfileMetric && !!state.profileData;

    // Redraw after modal becomes visible & after layout settles
    requestAnimationFrame(function () {
      var photoImg = $("modalRatioPhoto");
      var canvas = $("modalRatioCanvas");
      if (photoImg && canvas && state.analysis) {
        drawModalOverlay(canvas, photoImg, metric, state.analysis.landmarks, modalState.overlayVisible, isProfile);
      }
    });

    setTimeout(function () {
      var photoImg = $("modalRatioPhoto");
      var canvas = $("modalRatioCanvas");
      if (photoImg && canvas && state.analysis) {
        drawModalOverlay(canvas, photoImg, metric, state.analysis.landmarks, modalState.overlayVisible, isProfile);
      }
    }, 120);

    setTimeout(function () {
      var photoImg = $("modalRatioPhoto");
      var canvas = $("modalRatioCanvas");
      if (photoImg && canvas && state.analysis) {
        drawModalOverlay(canvas, photoImg, metric, state.analysis.landmarks, modalState.overlayVisible, isProfile);
      }
    }, 280);

    haptic("selection");
  }

  function closeRatioModal() {
    modalState.isOpen = false;
    var overlay = $("ratioModalOverlay");
    if (overlay) {
      overlay.classList.remove("is-open");
      overlay.setAttribute("aria-hidden", "true");
    }
    haptic("light");
  }

  var CELEBRITY_ARCHETYPES = {
    canthal_tilt: [
      { name: "Шон О'Прай (Sean O'Pry)", value: 7.8, note: "Ярко выраженный положительный угол (Hunter Eyes)" },
      { name: "Генри Кавилл (Henry Cavill)", value: 4.5, note: "Классический гармоничный угол" },
      { name: "Джейкоб Элорди (Jacob Elordi)", value: 0.2, note: "Нейтральный, расслабленный взгляд" }
    ],
    gonial_angle: [
      { name: "Брэд Питт (Brad Pitt)", value: 115.0, note: "Резкий скульптурный угол челюсти" },
      { name: "Дэвид Ганди (David Gandy)", value: 122.0, note: "Классический маскулинный баланс" },
      { name: "Тимоти Шаламе (Timothée Chalamet)", value: 130.0, note: "Мягкая утонченная линия челюсти" }
    ],
    lower_third: [
      { name: "Роберт Паттинсон (Robert Pattinson)", value: 36.2, note: "Выразительная мужественная нижняя треть" },
      { name: "Крис Хемсворт (Chris Hemsworth)", value: 35.0, note: "Идеальный золотой баланс 35%" },
      { name: "Леонардо ДиКаприо (Leonardo DiCaprio)", value: 33.5, note: "Сбалансированные пропорции третей" }
    ],
    vertical_symmetry: [
      { name: "Белла Хадид (Bella Hadid)", value: 98.4, note: "Высочайшая золотая симметрия" },
      { name: "Зендея (Zendaya)", value: 96.5, note: "Отличный естественный баланс сторон" },
      { name: "Райан Гослинг (Ryan Gosling)", value: 92.1, note: "Харизматичная лёгкая асимметрия" }
    ],
    midface_ratio: [
      { name: "Мэтт Бомер (Matt Bomer)", value: 0.98, note: "Компактная гармоничная средняя треть" },
      { name: "Киллиан Мёрфи (Cillian Murphy)", value: 1.02, note: "Высокие скулы и скульптурность" },
      { name: "Адам Драйвер (Adam Driver)", value: 1.15, note: "Удлинённая средняя зона лица" }
    ],
    lip_thickness: [
      { name: "Анджелина Джоли (Angelina Jolie)", value: 0.48, note: "Высокий чувственный объём губ" },
      { name: "Марго Робби (Margot Robbie)", value: 0.38, note: "Идеальный эстетический баланс" },
      { name: "Кира Найтли (Keira Knightley)", value: 0.28, note: "Аристократичный сдержанный объём" }
    ],
    cheekbone_prominence: [
      { name: "Джонни Депп (Johnny Depp)", value: 1.18, note: "Выразительные рельефные скулы" },
      { name: "Том Круз (Tom Cruise)", value: 1.12, note: "Сбалансированная ширина лица" },
      { name: "Джерард Батлер (Gerard Butler)", value: 1.06, note: "Широкая массивная челюсть" }
    ]
  };

  function renderModalCelebrities(metric) {
    var host = $("modalCelebList");
    if (!host) return;
    host.innerHTML = "";

    var key = metric.key;
    var list = CELEBRITY_ARCHETYPES[key];

    if (!list) {
      var low = metric.ideal_low;
      var high = metric.ideal_high;
      var center = metric.ideal_center;
      list = [
        { name: "Скульптурный архетип (Aesthetic Elite)", value: high, note: "Верхняя граница идеального референса" },
        { name: "Сбалансированный канон (Golden Standard)", value: center, note: "Математический центр гармонии" },
        { name: "Естественный контур (Natural Balance)", value: low, note: "Нижняя граница референсного диапазона" }
      ];
    }

    var userVal = metric.value;
    list.forEach(function (celeb) {
      var diff = Math.abs(userVal - celeb.value);
      var isClosest = diff <= (Math.abs(metric.scale_max - metric.scale_min) * 0.2);

      var item = document.createElement("div");
      item.className = "celeb-item";
      item.style.display = "flex";
      item.style.alignItems = "center";
      item.style.justifyContent = "space-between";
      item.style.padding = "12px 14px";
      item.style.borderRadius = "12px";
      item.style.border = isClosest ? "1.5px solid #22c55e" : "1px solid #e2e8f0";
      item.style.background = isClosest ? "#f0fdf4" : "#ffffff";
      item.style.marginBottom = "10px";

      item.innerHTML =
        '<div style="min-width:0;flex:1 1 auto;">' +
          '<div style="display:flex;align-items:center;gap:8px;">' +
            '<strong style="font-size:13.5px;color:#0f172a;">' + celeb.name + '</strong>' +
            (isClosest ? '<span style="background:#22c55e;color:#fff;font-size:9.5px;font-weight:700;padding:2px 7px;border-radius:999px;">ВАШ ТИП</span>' : "") +
          '</div>' +
          '<div style="font-size:11.5px;color:#64748b;margin-top:2px;">' + celeb.note + '</div>' +
        '</div>' +
        '<div style="font-size:14px;font-weight:750;color:#0f172a;margin-left:12px;white-space:nowrap;">' +
          fmt(celeb.value, 1) + (metric.unit || "") +
        '</div>';

      host.appendChild(item);
    });
  }

  function renderRatioModal(metricKey) {
    var metric = state.analysis.metrics[metricKey];
    if (!metric) return;

    var allKeys = getAllMetricKeys(state.analysis);
    var idx = allKeys.indexOf(metricKey);
    var posText = (idx >= 0 ? (idx + 1) : 1) + " / " + (allKeys.length || 52);

    $("modalRatioBadge").textContent = posText;
    $("modalRatioTitle").textContent = metric.label;

    var photoImg = $("modalRatioPhoto");
    var canvas = $("modalRatioCanvas");
    var isProfileMetric = metric.source === "profile" ||
      metric.key === "ramus_ratio" ||
      metric.key === "chin_projection" ||
      (metric.key === "gonial_angle" && !!state.profileData);
    var isProfile = isProfileMetric && !!state.profileData;
    var photoSrc = isProfile ? state.profileData : state.frontData;

    photoImg.src = photoSrc || "";
    photoImg.onload = function () {
      drawModalOverlay(canvas, photoImg, metric, state.analysis.landmarks, modalState.overlayVisible, isProfile);
    };
    if (photoImg.complete) {
      drawModalOverlay(canvas, photoImg, metric, state.analysis.landmarks, modalState.overlayVisible, isProfile);
    }

    animateCounter($("modalScoreVal"), 0, metric.score, 1, 380, "");

    var min = metric.scale_min;
    var max = metric.scale_max;
    var ratio = (metric.value - min) / Math.max(max - min, 1e-6);
    var pill = $("modalGradientPill");
    pill.style.left = clamp(ratio * 100, 5, 95) + "%";
    pill.textContent = metric.display;

    $("modalRangeMin").textContent = fmt(min, 2);
    $("modalRangeIdeal").textContent = "Ideal: " + fmt(metric.ideal_low, 2) + " – " + fmt(metric.ideal_high, 2);
    $("modalRangeMax").textContent = fmt(max, 2);

    $("modalAboutText").innerHTML =
      "<p>" + metric.description_ru + "</p>" +
      "<p>Ваше значение — <strong>" + metric.display + "</strong>, что " +
        metric.direction_ru + ". Референсный диапазон нормы: " +
        fmt(metric.ideal_low, 2) + " – " + fmt(metric.ideal_high, 2) + ".</p>";

    var contribList = $("modalContribList");
    contribList.innerHTML = "";
    var insights = getContributesInsights(metric);
    $("modalContribCount").textContent = String(insights.length);
    insights.forEach(function (c) {
      var item = document.createElement("div");
      item.className = "contributes-item";
      item.innerHTML =
        '<span class="contributes-item__icon">' + c.icon + "</span>" +
        "<div>" +
          '<div class="contributes-item__title">' + c.title + "</div>" +
          '<div class="contributes-item__desc">' + c.desc + "</div>" +
        "</div>";
      contribList.appendChild(item);
    });

    $("modalCurveHost").innerHTML = buildBellCurveSvg(metric);
    $("modalCurveValue").textContent = metric.display + " (" + fmt(metric.score, 1) + "/10)";

    var simRange = $("modalSimRange");
    if (simRange) {
      simRange.value = Math.round(clamp(ratio * 100, 0, 100));
      $("modalSimValText").textContent = metric.display;
      $("modalSimScoreText").textContent = fmt(metric.score, 1) + " / 10";
    }

    var noteInput = $("modalNoteText");
    if (noteInput) {
      noteInput.value = safeGet("fl_note_" + metricKey) || "";
    }

    renderModalCelebrities(metric);

    setModalTab("overview");
  }

  function setModalTab(tab) {
    modalState.tab = tab;
    qsa("#ratioModalContainer .ratio-modal-tab-btn").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.getAttribute("data-modaltab") === tab);
    });
    var tabs = ["overview", "simulate", "celebrities", "edit"];
    tabs.forEach(function (t) {
      var pane = $("modalTab" + t.charAt(0).toUpperCase() + t.slice(1));
      if (pane) {
        pane.style.display = t === tab ? "block" : "none";
        if (t === tab) {
          pane.style.animation = "flRowSlideUp 0.26s cubic-bezier(0.16, 1, 0.3, 1) both";
        }
      }
    });
    haptic("selection");
  }

  function navigateModal(delta) {
    if (!state.analysis || !modalState.key) return;
    var keys = getAllMetricKeys(state.analysis);
    var idx = keys.indexOf(modalState.key);
    if (idx === -1) return;
    var nextIdx = idx + delta;
    if (nextIdx < 0) nextIdx = keys.length - 1;
    if (nextIdx >= keys.length) nextIdx = 0;
    openRatioModal(keys[nextIdx]);
  }

  function bindModalEvents() {
    var overlay = $("ratioModalOverlay");
    var closeBtn = $("modalCloseBtn");
    var prevBtn = $("modalPrevBtn");
    var nextBtn = $("modalNextBtn");
    var eyeBtn = $("modalEyeBtn");

    if (closeBtn) {
      closeBtn.addEventListener("click", closeRatioModal);
    }
    if (overlay) {
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) closeRatioModal();
      });
    }
    if (prevBtn) {
      prevBtn.addEventListener("click", function () {
        navigateModal(-1);
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener("click", function () {
        navigateModal(1);
      });
    }
    if (eyeBtn) {
      eyeBtn.addEventListener("click", function () {
        modalState.overlayVisible = !modalState.overlayVisible;
        eyeBtn.style.opacity = modalState.overlayVisible ? "1" : "0.5";
        if (state.analysis && modalState.key) {
          var metric = state.analysis.metrics[modalState.key];
          var canvas = $("modalRatioCanvas");
          var photo = $("modalRatioPhoto");
          var isProfileMetric = metric.source === "profile" ||
            metric.key === "ramus_ratio" ||
            metric.key === "chin_projection" ||
            (metric.key === "gonial_angle" && !!state.profileData);
          var isProfile = isProfileMetric && !!state.profileData;
          drawModalOverlay(canvas, photo, metric, state.analysis.landmarks, modalState.overlayVisible, isProfile);
        }
      });
    }

    var askGptBtn = $("modalAskGptBtn");
    if (askGptBtn) {
      askGptBtn.addEventListener("click", function () {
        if (!state.analysis || !modalState.key) return;
        var metric = state.analysis.metrics[modalState.key];
        closeRatioModal();
        setView("facegpt");
        var qText = "Расскажи подробно про мою метрику " + metric.label + ": текущее значение " + metric.display + ", оценка " + fmt(metric.score, 1) + "/10. Как мне ее подчеркнуть или скорректировать?";
        sendToGemini(qText);
      });
    }

    qsa("#ratioModalContainer .ratio-modal-tab-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setModalTab(btn.getAttribute("data-modaltab"));
      });
    });

    document.addEventListener("keydown", function (e) {
      if (!modalState.isOpen) return;
      if (e.key === "Escape") closeRatioModal();
      if (e.key === "ArrowLeft") navigateModal(-1);
      if (e.key === "ArrowRight") navigateModal(1);
    });

    window.addEventListener("resize", function () {
      if (modalState.isOpen && state.analysis && modalState.key) {
        var metric = state.analysis.metrics[modalState.key];
        var photo = $("modalRatioPhoto");
        var canvas = $("modalRatioCanvas");
        if (photo && canvas) {
          drawModalOverlay(canvas, photo, metric, state.analysis.landmarks, modalState.overlayVisible);
        }
      }
    });

    var simRange = $("modalSimRange");
    if (simRange) {
      simRange.addEventListener("input", function () {
        if (!state.analysis || !modalState.key) return;
        var metric = state.analysis.metrics[modalState.key];
        var min = metric.scale_min;
        var max = metric.scale_max;
        var val = min + (simRange.value / 100) * (max - min);
        var score = gaussianScore(val, metric.ideal_low, metric.ideal_high);
        $("modalSimValText").textContent = fmt(val, 2) + (metric.unit || "");
        $("modalSimScoreText").textContent = fmt(score, 1) + " / 10";
      });
    }
    var simReset = $("modalSimResetBtn");
    if (simReset) {
      simReset.addEventListener("click", function () {
        if (!state.analysis || !modalState.key) return;
        var metric = state.analysis.metrics[modalState.key];
        var min = metric.scale_min;
        var max = metric.scale_max;
        var ratio = (metric.value - min) / Math.max(max - min, 1e-6);
        if (simRange) simRange.value = Math.round(ratio * 100);
        $("modalSimValText").textContent = metric.display;
        $("modalSimScoreText").textContent = fmt(metric.score, 1) + " / 10";
      });
    }

    var saveNote = $("modalSaveNoteBtn");
    if (saveNote) {
      saveNote.addEventListener("click", function () {
        if (!modalState.key) return;
        var note = $("modalNoteText").value;
        safeSet("fl_note_" + modalState.key, note);
        toast("Заметка сохранена!");
      });
    }
  }

  /* ------------------------------------------------------------- plan view */

  var PLAN_ADVICE = {
    harmony: "Работайте с осанкой и положением головы: смещение шеи вперёд визуально " +
      "меняет пропорции нижней трети. Съёмка с уровня глаз убирает искажения.",
    angularity: "Снижение задержки жидкости и общего процента жира заметнее всего " +
      "проявляется на линии челюсти. Сон, соль и алкоголь дают быстрый видимый эффект.",
    dimorphism: "Диморфные черты почти не меняются, но их подача зависит от формы бровей, " +
      "стрижки и растительности на лице.",
    features: "Черты фиксированы геометрией. Работает акцентирование: брови, ресницы, " +
      "уход за губами.",
    skin: "Базовый протокол: мягкое очищение, SPF каждый день, ретиноид на ночь " +
      "с постепенным вводом, увлажнение с церамидами.",
    hair: "Плотность зависит от питания, сна и ухода за кожей головы. " +
      "Резкие изменения плотности стоит показать трихологу."
  };

  function renderPlan(data) {
    var host = $("planList");
    if (!host) return;
    host.innerHTML = "";

    var curScore = data.overall ? data.overall.score : 8.0;
    var curEl = $("planCurrentScore");
    if (curEl) curEl.textContent = fmt(curScore, 2);
    var tarEl = $("planTargetScore");
    if (tarEl) tarEl.textContent = fmt(Math.min(curScore + 1.18, 9.85), 2);
    var potEl = $("planPotentialScore");
    if (potEl) potEl.textContent = fmt(Math.min(curScore + 1.94, 9.94), 2);

    var improvements = (data.top_improvements || []).slice(0, 4);
    var steps = [];

    improvements.forEach(function (imp, i) {
      var metric = data.metrics[imp.key];
      var catName = imp.category ? (imp.category.charAt(0).toUpperCase() + imp.category.slice(1)) : "Harmony";
      var advice = imp.advice_ru || (metric ? metric.advice_ru : "") || "Оптимизация баланса и регулярный уход.";
      steps.push({
        num: i + 1,
        title: imp.label + ": Протокол гармонизации",
        tag: i === 0 ? "ПРИОРИТЕТ 1" : (i === 1 ? "ПРИОРИТЕТ 2" : "ПРИОРИТЕТ 3"),
        cat: catName,
        desc: advice,
        metricKey: imp.key,
        metricLabel: imp.label,
        cost: i % 2 === 0 ? "$0 (естественные практики)" : "$30 – $80",
        impact: "+0." + (45 - i * 8) + " " + catName
      });
    });

    if (!steps.length) {
      steps = [
        {
          num: 1,
          title: "Lymphatic Drainage & Posture Alignment",
          tag: "MINIMALLY INVASIVE",
          cat: "Angularity & Submental",
          desc: "Коррекция осанки шейного отдела (устранение переднего положения головы) и лимфодренажный протокол для очерчивания угла нижней челюсти.",
          metricLabel: "Осанка и лимфодренаж",
          cost: "$0 – $45",
          impact: "+0.45 Harmony"
        },
        {
          num: 2,
          title: "Targeted Masseter Tone & Oral Posture (Mewing)",
          tag: "NON-INVASIVE",
          cat: "Jaw & Symmetry",
          desc: "Оптимизация положения языка у нёба в покое, выравнивание симметрии жевания на обе стороны и контроль гипертонуса жевательных мышц.",
          metricLabel: "Линия челюсти и положение языка",
          cost: "$0",
          impact: "+0.38 Angularity"
        }
      ];
    }

    steps.forEach(function (step) {
      var item = document.createElement("div");
      item.className = "plan-timeline-card";
      item.style.cssText = "background:#ffffff;border:1px solid #edf0f3;border-radius:16px;padding:20px;margin-bottom:14px;box-shadow:var(--shadow);";
      item.innerHTML =
        '<div style="display:flex;align-items:flex-start;gap:16px;">' +
          '<div style="width:36px;height:36px;border-radius:50%;background:#0f172a;color:#ffffff;display:grid;place-items:center;font-weight:750;font-size:15px;flex:0 0 36px;">' +
            step.num +
          '</div>' +
          '<div style="flex:1 1 auto;min-width:0;">' +
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">' +
              '<span style="font-size:10.5px;font-weight:750;letter-spacing:0.06em;background:#f1f5f9;color:#475569;padding:3px 8px;border-radius:6px;">' + step.tag + '</span>' +
              '<span style="font-size:11.5px;color:var(--muted);">' + step.cat + '</span>' +
            '</div>' +
            '<h4 style="font-size:16px;font-weight:750;color:#0f172a;margin:0 0 8px;">' + step.title + '</h4>' +
            '<p style="font-size:13px;color:#475569;line-height:1.5;margin:0 0 14px;">' + step.desc + '</p>' +
            '<div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid #f1f5f9;padding-top:12px;font-size:12px;flex-wrap:wrap;gap:8px;">' +
              '<span style="color:var(--muted);">Ориентировочная стоимость: <strong style="color:#0f172a;">' + step.cost + '</strong></span>' +
              '<span style="color:var(--teal);font-weight:700;">' + step.impact + '</span>' +
            '</div>' +
            '<button type="button" class="btn btn--ghost btn--sm plan-ask-ai-btn" style="margin-top:12px;width:100%;font-size:12px;font-weight:650;" data-plan-title="' + step.title + '">' +
              '✨ Составить подробный план с Gemini AI' +
            '</button>' +
          '</div>' +
        '</div>';
      host.appendChild(item);
    });

    qsa(".plan-ask-ai-btn", host).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var pTitle = btn.getAttribute("data-plan-title");
        setView("facegpt");
        var prompt = "Составь для меня детальный пошаговый недельный план по направлению: '" + pTitle + "'. Распиши упражнения, частоту, режим дня и ожидаемые сроки результата.";
        sendToGemini(prompt);
      });
    });
  }

  /* ---------------------------------------------------------- simulate view */

  function initSimulate(data) {
    var select = $("simMetric");
    var range = $("simRange");
    if (!select || !range) {
      return;
    }

    select.innerHTML = "";
    (data.category_order || []).forEach(function (catKey) {
      var cat = catByKey(catKey);
      if (!cat) {
        return;
      }
      var group = document.createElement("optgroup");
      group.label = cat.title + " · " + cat.title_ru;
      (cat.metrics || []).forEach(function (metric) {
        var option = document.createElement("option");
        option.value = metric.key;
        option.textContent = metric.label;
        group.appendChild(option);
      });
      select.appendChild(group);
    });

    var lowest = (data.top_improvements || [])[0];
    state.simKey = lowest ? lowest.key : Object.keys(data.metrics)[0];
    select.value = state.simKey;

    select.addEventListener("change", function () {
      state.simKey = select.value;
      syncSimulate(true);
    });
    range.addEventListener("input", function () {
      syncSimulate(false);
    });
    $("simReset").addEventListener("click", function () {
      syncSimulate(true);
    });

    var simModalBtn = $("simOpenModalBtn");
    if (simModalBtn) {
      simModalBtn.addEventListener("click", function () {
        if (state.simKey) {
          openRatioModal(state.simKey);
        }
      });
    }

    syncSimulate(true);
  }

  function gaussianScore(value, lo, hi) {
    var center = (lo + hi) / 2;
    var half = Math.max(Math.abs(hi - lo) / 2, 1e-6);
    var sigma = half / Math.sqrt(2 * Math.log(10 / 8.7));
    var dist = Math.abs(value - center);
    if (dist <= half) {
      return clamp(10 * Math.exp(-(dist * dist) / (2 * sigma * sigma)), 0, 10);
    }
    var extra = (dist - half) / half;
    return clamp(8.7 / (1.0 + 0.9 * Math.pow(extra, 1.3)), 0, 10);
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

  function syncSimulate(reset) {
    var data = state.analysis;
    var metric = data.metrics[state.simKey];
    if (!metric) {
      return;
    }

    var range = $("simRange");
    var min = metric.scale_min;
    var max = metric.scale_max;
    var span = Math.max(max - min, 1e-6);

    if (reset) {
      range.value = String(Math.round(((metric.value - min) / span) * 100));
    }

    var ratio = Number(range.value) / 100;
    var value = min + ratio * span;
    var score = gaussianScore(value, metric.ideal_low, metric.ideal_high);
    var color = scoreColorName(score);

    $("simMetricName").textContent = metric.label;
    $("simValue").textContent = metric.unit === "%"
      ? fmt(value, 1) + "%"
      : metric.unit === "°"
        ? fmt(value, 1) + "°"
        : fmt(value, 3);
    $("simMin").textContent = fmt(min, 2);
    $("simMax").textContent = fmt(max, 2);

    var idealLeft = clamp(((metric.ideal_low - min) / span) * 100, 0, 100);
    var idealWidth = clamp(((metric.ideal_high - metric.ideal_low) / span) * 100, 0, 100);
    $("simIdeal").style.left = idealLeft + "%";
    $("simIdeal").style.width = idealWidth + "%";
    $("simCenter").style.left = clamp(((metric.ideal_center - min) / span) * 100, 0, 100) + "%";
    $("simMarker").style.left = clamp(ratio * 100, 0, 100) + "%";
    $("simMarker").style.borderColor = colorVar(color);

    var scoreEl = $("simScore");
    scoreEl.textContent = fmt(score, 1) + " / 10";
    scoreEl.style.color = colorVar(color);

    var delta = score - metric.score;
    var cat = catByKey(metric.category);
    var catDelta = cat && cat.metric_count ? delta / cat.metric_count : 0;
    var weight = cat ? cat.weight : 0;
    var projected = data.overall.score + catDelta * weight / totalWeight(data);

    var overallEl = $("simOverall");
    overallEl.textContent = fmt(clamp(projected, 0, 10), 2) +
      " (" + (delta >= 0 ? "+" : "") + fmt(delta, 1) + ")";
    overallEl.style.color = colorVar(scoreColorName(clamp(projected, 0, 10)));
  }

  function totalWeight(data) {
    var sum = 0;
    (data.categories || []).forEach(function (cat) {
      if (cat.metric_count) {
        sum += cat.weight;
      }
    });
    return sum || 1;
  }

  /* -------------------------------------------------------- landmark overlay */

  function renderOverlay() {
    var data = state.analysis;
    var canvas = $("landmarkCanvas");
    var photo = $("landmarkPhoto");
    if (!canvas || !photo || !data || !data.landmarks || !data.landmarks.front) {
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

    if (state.overlay === "off") {
      return;
    }

    var points = data.landmarks.front;

    if (state.overlay === "mesh") {
      ctx.fillStyle = "rgba(43, 184, 168, 0.85)";
      points.forEach(function (point) {
        ctx.beginPath();
        ctx.arc(point[0] * width, point[1] * height, 1.05, 0, Math.PI * 2);
        ctx.fill();
      });
      return;
    }

    var AXES = [
      [10, 152],
      [33, 263],
      [61, 291],
      [129, 358],
      [234, 454],
      [132, 288],
      [105, 334]
    ];
    ctx.strokeStyle = "rgba(21, 25, 29, 0.72)";
    ctx.lineWidth = 1.4;
    AXES.forEach(function (pair) {
      var a = points[pair[0]];
      var b = points[pair[1]];
      if (!a || !b) {
        return;
      }
      ctx.beginPath();
      ctx.moveTo(a[0] * width, a[1] * height);
      ctx.lineTo(b[0] * width, b[1] * height);
      ctx.stroke();
    });

    ctx.fillStyle = "rgba(43, 184, 168, 0.95)";
    AXES.forEach(function (pair) {
      pair.forEach(function (index) {
        var point = points[index];
        if (!point) {
          return;
        }
        ctx.beginPath();
        ctx.arc(point[0] * width, point[1] * height, 3.2, 0, Math.PI * 2);
        ctx.fill();
      });
    });
  }

  /* ------------------------------------------------------------ FaceGPT view */

  function gptAnswer(kind) {
    var data = state.analysis;
    if (!data) {
      return "Сначала выполните анализ.";
    }

    var overall = data.overall;
    var best = (data.top_strengths || [])[0];
    var worst = (data.top_improvements || [])[0];

    if (kind === "strong") {
      var lines = (data.top_strengths || []).map(function (item) {
        return "<p><strong>" + item.label + "</strong> — " + item.display +
          ", оценка " + fmt(item.score, 1) + ".</p>";
      }).join("");
      return "<p>Ваш общий балл " + fmt(overall.score, 1) + " из 10, перцентиль " +
        overall.percentile + ". Лучше всего выглядят такие показатели:</p>" + lines;
    }

    if (kind === "weak") {
      var weak = (data.top_improvements || []).map(function (item) {
        return "<p><strong>" + item.label + "</strong> — " + item.display +
          ", " + item.direction_ru + ". Оценка " + fmt(item.score, 1) + ".</p>";
      }).join("");
      return "<p>Наибольший потенциал роста здесь:</p>" + weak +
        "<p>Часть этих метрик — фиксированная геометрия черепа, часть зависит " +
        "от состава тела, отёчности и ухода.</p>";
    }

    if (kind === "harmony") {
      var cat = catByKey("harmony");
      var sym = data.metrics.vertical_symmetry;
      var bal = data.metrics.facial_thirds_balance;
      return "<p>Категория Harmony — " + fmt(cat.score, 1) + " из 10.</p>" +
        "<p>Вертикальная симметрия " + sym.display + ", баланс третей " + bal.display + ".</p>" +
        "<p>Симметрия лица частично корректируется осанкой и миофасциальным массажем.</p>";
    }

    if (kind === "jaw") {
      var gonial = data.metrics.gonial_angle;
      var jawCheek = data.metrics.jaw_cheek_ratio;
      var mandible = data.metrics.mandible_definition;
      return "<p>Gonial Angle — " + gonial.display + " (" + gonial.rating_ru +
        "), референс " + fmt(gonial.ideal_low, 0) + "–" + fmt(gonial.ideal_high, 0) + "°.</p>" +
        "<p>Jaw to Cheek Ratio — " + jawCheek.display + ", Mandible Definition — " +
        mandible.display + ".</p><p>Чем меньше угол гониона, тем резче читается " +
        "линия челюсти.</p>";
    }

    if (kind === "skin") {
      var cat = catByKey("skin");
      var evenness = data.metrics.skin_evenness;
      var clarity = data.metrics.skin_clarity;
      var undereye = data.metrics.undereye_darkness;
      return "<p>Категория Skin — " + fmt(cat.score, 1) + " из 10.</p>" +
        "<p>Ровность тона " + evenness.display + ", чистота " + clarity.display +
        ", затемнение под глазами " + undereye.display + ".</p>" +
        "<p>Учтите: пиксельные метрики чувствительны к освещению кадра.</p>";
    }

    return "<p>Общий балл " + fmt(overall.score, 1) + ". Сильнее всего — " +
      (best ? best.label : "—") + ", слабее — " + (worst ? worst.label : "—") + ".</p>";
  }

  var gptHistory = [];

  function formatMarkdown(text) {
    if (!text) return "";
    var html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    html = html.replace(/^[*-]\s+(.+)$/gm, "<li>$1</li>");
    html = html.replace(/\n\n+/g, "</p><p>").replace(/\n/g, "<br/>");
    return "<p>" + html + "</p>";
  }

  function appendChatMsg(role, contentHtml, isTemp) {
    var host = $("gptChatHistory");
    if (!host) return null;
    var msg = document.createElement("div");
    msg.className = "facegpt-msg " + (role === "user" ? "facegpt-msg--user" : "facegpt-msg--bot");
    var avatar = role === "user" ? "👤" : "✨";
    msg.innerHTML =
      '<div class="facegpt-msg__avatar">' + avatar + '</div>' +
      '<div class="facegpt-msg__content prose">' + contentHtml + '</div>';
    if (isTemp) {
      msg.id = "gptTempMsg";
    }
    host.appendChild(msg);
    host.scrollTop = host.scrollHeight;
    return msg;
  }

  function sendToGemini(userText) {
    if (!userText || !userText.trim()) return;
    var text = userText.trim();

    appendChatMsg("user", text);

    var temp = appendChatMsg("bot", '<div class="typing-bubble"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span><span style="font-size:12.5px;color:#64748b;margin-left:8px;font-weight:600;">FaceGPT анализирует пропорции лица...</span></div>', true);

    var ctx = null;
    if (state.analysis) {
      var d = state.analysis;
      var strengthsLabels = (d.top_strengths || []).map(function (s) { return s.label + " (" + s.display + ")"; });
      var improveLabels = (d.top_improvements || []).map(function (s) { return s.label + " (" + s.display + ")"; });
      ctx = {
        overall_score: d.overall ? d.overall.score : 0,
        gender: d.gender,
        ethnicity: d.ethnicity,
        strengths: strengthsLabels,
        improvements: improveLabels
      };
    }

    var payload = {
      message: text,
      context: ctx,
      image: state.frontData || null,
      history: gptHistory
    };

    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (temp && temp.parentNode) {
          temp.parentNode.removeChild(temp);
        }
        var replyText = data.reply || "Не удалось получить ответ от Gemini.";
        gptHistory.push({ role: "user", text: text });
        gptHistory.push({ role: "model", text: replyText });
        appendChatMsg("bot", formatMarkdown(replyText));
      })
      .catch(function (err) {
        if (temp && temp.parentNode) {
          temp.parentNode.removeChild(temp);
        }
        appendChatMsg("bot", "<strong>Ошибка соединения:</strong> " + err.message);
      });
  }

  function bindGpt() {
    qsa("#gptChips .chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var qText = chip.textContent.trim();
        // Remove emoji prefix if any for cleaner prompt
        var cleanText = qText.replace(/^[\uD800-\uDBFF\uDC00-\uDFFF\s✨🎯💇📐🧴👁]+/, "").trim();
        sendToGemini(cleanText || qText);
      });
    });

    var sendBtn = $("gptSendBtn");
    var inputEl = $("gptUserInput");
    if (sendBtn && inputEl) {
      sendBtn.addEventListener("click", function () {
        var val = inputEl.value.trim();
        if (val) {
          inputEl.value = "";
          sendToGemini(val);
        }
      });

      inputEl.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          var val = inputEl.value.trim();
          if (val) {
            inputEl.value = "";
            sendToGemini(val);
          }
        }
      });
    }
  }

  /* ---------------------------------------------------------------- views */

  function setView(view) {
    state.view = view;
    var map = {
      overview: "viewOverview",
      analysis: "viewAnalysis",
      plan: "viewPlan",
      simulate: "viewSimulate",
      facegpt: "viewFacegpt"
    };
    Object.keys(map).forEach(function (key) {
      var el = $(map[key]);
      if (el) {
        el.hidden = key !== view;
        el.classList.toggle("is-active", key === view);
      }
    });
    qsa("#topnav .topnav__item").forEach(function (item) {
      item.classList.toggle("is-active", item.getAttribute("data-view") === view);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function bindViews() {
    qsa("#topnav .topnav__item").forEach(function (item) {
      item.addEventListener("click", function () {
        setView(item.getAttribute("data-view"));
      });
    });

    var askGptLink = $("askFaceGptLink");
    if (askGptLink) {
      askGptLink.addEventListener("click", function () {
        setView("facegpt");
        var cat = catByKey(currentAnalysisCat) || catByKey("harmony");
        var prompt = "Сделай подробный разбор моей категории " + (cat ? cat.title : "Harmony") + ". Какие метрики в ней самые сильные, какие требуют внимания и как их скорректировать?";
        sendToGemini(prompt);
      });
    }

    qsa("#overlayToggle .toggle__btn").forEach(function (button) {
      button.addEventListener("click", function () {
        state.overlay = button.getAttribute("data-overlay");
        qsa("#overlayToggle .toggle__btn").forEach(function (other) {
          other.classList.toggle("is-active", other === button);
        });
        renderOverlay();
      });
    });
  }

  /* ------------------------------------------------------------------ init */

  function restoreSession() {
    var raw = safeGet(STORAGE.analysis);
    if (!raw) {
      return false;
    }
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.metrics || !parsed.overall) {
        return false;
      }
      state.analysis = parsed;
      state.gender = parsed.gender;
      state.ethnicity = parsed.ethnicity;
      state.frontData = safeGet(STORAGE.front);
      state.profileData = safeGet(STORAGE.profile);
      return true;
    } catch (error) {
      return false;
    }
  }

  function bindCta() {
    $("ctaBtn").addEventListener("click", function () {
      if (state.step === 1) {
        updateChoiceEcho();
        setStep(2);
        return;
      }
      if (state.step === 2) {
        runAnalysis();
        return;
      }
      if (state.step === 4) {
        setView("analysis");
      }
    });

    $("backToStep1").addEventListener("click", function () {
      setStep(1);
    });

    $("restartBtn").addEventListener("click", function () {
      state.analysis = null;
      state.frontFile = null;
      state.profileFile = null;
      state.frontData = null;
      state.profileData = null;
      ["dropFront", "dropProfile"].forEach(function (id) {
        var drop = $(id);
        if (drop) {
          drop.classList.remove("has-image");
        }
      });
      ["fileFront", "fileProfile"].forEach(function (id) {
        var input = $(id);
        if (input) {
          input.value = "";
        }
      });
      try {
        window.localStorage.removeItem(STORAGE.analysis);
      } catch (error) {
        toast("Не удалось очистить хранилище.", true);
      }
      setStep(1);
    });

    var pwClose = $("paywallCloseBtn");
    if (pwClose) {
      pwClose.addEventListener("click", function () {
        hidePaywall();
      });
    }
  }

  function preselect() {
    var gender = safeGet(STORAGE.gender);
    var ethnicity = safeGet(STORAGE.ethnicity);
    if (gender && GENDER_RU[gender]) {
      state.gender = gender;
      qsa("#genderGrid .choice").forEach(function (button) {
        button.setAttribute("aria-pressed",
          String(button.getAttribute("data-gender") === gender));
      });
    }
    if (ethnicity && ETH_RU[ethnicity]) {
      state.ethnicity = ethnicity;
      qsa("#ethnicityGrid .choice").forEach(function (button) {
        button.setAttribute("aria-pressed",
          String(button.getAttribute("data-ethnicity") === ethnicity));
      });
    }
    updateChoiceEcho();
  }

  function init() {
    var appEl = $("app");
    var gateEl = $("gateScreen");

    if (tgApp && tgInitData) {
      var fd = new FormData();
      fd.append("initData", tgInitData);
      window.fetch("/api/telegram/verify", { method: "POST", body: fd })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.ok || !data.can_analyse) {
            if (appEl) appEl.style.display = "none";
            if (gateEl) gateEl.style.display = "";
            var payBtn = $("gatePayBtn");
            if (payBtn) {
              payBtn.addEventListener("click", function () {
                if (tgApp && typeof tgApp.close === "function") {
                  tgApp.close();
                } else {
                  window.location.href = "https://t.me/FaceLabs_bot";
                }
              });
            }
          } else {
            if (gateEl) gateEl.style.display = "none";
            if (appEl) appEl.style.display = "";
            bootApp();
          }
        })
        .catch(function () {
          if (gateEl) gateEl.style.display = "none";
          if (appEl) appEl.style.display = "";
          bootApp();
        });
    } else {
      if (gateEl) gateEl.style.display = "none";
      if (appEl) appEl.style.display = "";
      bootApp();
    }
  }

  function bindSidebar() {
    var sidebar = $("fiqSidebar");
    var collapseBtn = $("sidebarCollapseBtn");
    var menuBtn = $("fiqMobileMenuBtn");
    var newBtn = $("fiqNewScanBtn");
    var backdrop = $("fiqSidebarBackdrop");

    function setDrawer(open) {
      if (!sidebar) return;
      sidebar.classList.toggle("is-open", open);
      if (backdrop) backdrop.classList.toggle("is-visible", open);
    }

    if (collapseBtn && sidebar) {
      collapseBtn.addEventListener("click", function () {
        setDrawer(!sidebar.classList.contains("is-open"));
      });
    }
    if (menuBtn && sidebar) {
      menuBtn.addEventListener("click", function () {
        setDrawer(!sidebar.classList.contains("is-open"));
      });
    }
    if (backdrop) {
      backdrop.addEventListener("click", function () {
        setDrawer(false);
      });
    }
    if (newBtn) {
      newBtn.addEventListener("click", function () {
        var restart = $("restartBtn");
        if (restart) restart.click();
      });
    }

    qsa(".fiq-sidebar__section a.fiq-nav-item").forEach(function (link) {
      link.addEventListener("click", function (e) {
        e.preventDefault();
        var txt = link.textContent.trim();
        if (txt.indexOf("Partnership") !== -1) {
          toast("🤝 Партнёрская программа FaceIQ: сотрудничество для клиник и барбершопов (@faceiq_partners)");
        } else if (txt.indexOf("Creator") !== -1) {
          toast("🏆 Creator League: закрытое сообщество FaceIQ с приоритетным доступом к AI!");
        } else if (txt.indexOf("Research") !== -1) {
          toast("🔬 Research: 52 антропометрических индекса на базе MediaPipe FaceLandmarker.");
        }
        haptic("light");
      });
    });

    if (tgApp && tgApp.initDataUnsafe && tgApp.initDataUnsafe.user) {
      var user = tgApp.initDataUnsafe.user;
      var nameEl = $("fiqUserName");
      if (nameEl) nameEl.textContent = user.first_name + (user.last_name ? " " + user.last_name : "");
      var avatar = document.querySelector(".fiq-user-card__avatar");
      if (avatar) avatar.textContent = user.first_name.charAt(0).toUpperCase();
    }
  }

  function bindCategoryTabs() {
    qsa("#heroPillTabs .fiq-pill-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var catKey = btn.getAttribute("data-cat");
        qsa("#heroPillTabs .fiq-pill-tab").forEach(function (b) {
          b.classList.toggle("is-active", b === btn);
        });
        var cat = catByKey(catKey);
        if (cat) {
          var titleEl = $("heroCatTitle");
          var scoreEl = $("heroCatScore");
          if (titleEl) titleEl.textContent = cat.title.toUpperCase();
          if (scoreEl) scoreEl.innerHTML = fmt(cat.score, 2) + ' <span style="font-size:12px;color:var(--muted)">/10</span>';
        }
      });
    });

    qsa("#analysisCatTabs .fiq-pill-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var catKey = btn.getAttribute("data-cat");
        currentAnalysisCat = catKey;
        qsa("#analysisCatTabs .fiq-pill-tab").forEach(function (b) {
          b.classList.toggle("is-active", b === btn);
        });
        var cat = catByKey(catKey);
        var tagEl = $("analysisPhotoTag");
        if (tagEl && cat) tagEl.textContent = "Front " + cat.title;
        if (state.analysis) renderAnalysisGroups(state.analysis);
      });
    });

    var toggleFront = $("analysisToggleFront");
    var toggleSide = $("analysisToggleSide");
    if (toggleFront && toggleSide) {
      toggleFront.addEventListener("click", function () {
        toggleFront.classList.add("is-active");
        toggleSide.classList.remove("is-active");
        var photoStage = $("analysisPhotoStage");
        if (photoStage && state.frontData) {
          photoStage.src = state.frontData;
        }
        var cat = catByKey(currentAnalysisCat) || catByKey("harmony");
        var tagEl = $("analysisPhotoTag");
        if (tagEl && cat) tagEl.textContent = "Front " + cat.title;
        if (state.analysis) renderAnalysisGroups(state.analysis);
      });

      toggleSide.addEventListener("click", function () {
        toggleSide.classList.add("is-active");
        toggleFront.classList.remove("is-active");
        var photoStage = $("analysisPhotoStage");
        if (photoStage) {
          photoStage.src = state.profileData || state.frontData || "";
        }
        var cat = catByKey(currentAnalysisCat) || catByKey("harmony");
        var tagEl = $("analysisPhotoTag");
        if (tagEl && cat) tagEl.textContent = "Side " + cat.title;
        if (state.analysis) renderAnalysisGroups(state.analysis);
      });
    }

    var sideHeroBox = $("resultProfile");
    if (sideHeroBox) {
      sideHeroBox.style.cursor = "pointer";
      sideHeroBox.addEventListener("click", function () {
        if (toggleSide) toggleSide.click();
        setView("analysis");
      });
    }
    var frontHeroBox = $("resultFront");
    if (frontHeroBox) {
      frontHeroBox.style.cursor = "pointer";
      frontHeroBox.addEventListener("click", function () {
        if (toggleFront) toggleFront.click();
        setView("analysis");
      });
    }

    var askGpt = $("askFaceGptLink");
    if (askGpt) {
      askGpt.addEventListener("click", function () {
        setView("facegpt");
      });
    }
  }

  function bindShowMoreButtons() {
    var sBtn = $("showMoreStrengthsBtn");
    if (sBtn) {
      sBtn.addEventListener("click", function () {
        strengthsExpanded = !strengthsExpanded;
        if (state.analysis) renderInsights(state.analysis);
      });
    }

    var iBtn = $("showMoreImprovementsBtn");
    if (iBtn) {
      iBtn.addEventListener("click", function () {
        improvementsExpanded = !improvementsExpanded;
        if (state.analysis) renderInsights(state.analysis);
      });
    }

    qsa("#strengthsCatTabs .fiq-pill-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        qsa("#strengthsCatTabs .fiq-pill-tab").forEach(function (t) {
          t.classList.toggle("is-active", t === tab);
        });
        strengthsFilterCat = tab.getAttribute("data-cat");
        strengthsExpanded = false;
        if (state.analysis) renderInsights(state.analysis);
      });
    });

    qsa("#improvementsCatTabs .fiq-pill-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        qsa("#improvementsCatTabs .fiq-pill-tab").forEach(function (t) {
          t.classList.toggle("is-active", t === tab);
        });
        improvementsFilterCat = tab.getAttribute("data-cat");
        improvementsExpanded = false;
        if (state.analysis) renderInsights(state.analysis);
      });
    });
  }

  function bindTopbarActions() {
    var shareBtn = $("topbarShareBtn");
    if (shareBtn) {
      shareBtn.addEventListener("click", function () {
        var score = state.analysis && state.analysis.overall ? fmt(state.analysis.overall.score, 1) : "8.6";
        var text = "Мой результат в FaceIQ Labs: " + score + " / 10! Проверь свои пропорции лица на http://127.0.0.1:8000";
        if (navigator.share) {
          navigator.share({
            title: "FaceIQ Labs - Отчет о гармонии лица",
            text: text,
            url: window.location.href
          }).catch(function () {});
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            toast("Ссылка и результат скопированы в буфер обмена! 📋");
          });
        } else {
          toast("Ваш результат: " + score + " / 10! 🌟");
        }
        haptic("light");
      });
    }

    var adjustBtn = $("topbarAdjustBtn");
    if (adjustBtn) {
      adjustBtn.addEventListener("click", function () {
        setView("simulate");
        haptic("selection");
      });
    }

    var helpBtn = $("topbarHelpBtn");
    if (helpBtn) {
      helpBtn.addEventListener("click", function () {
        toast("FaceIQ: 52 биометрических показателя MediaPipe. 8–10 Отлично, 6–8 Хорошо, 4–6 Средне, 0–4 Зона роста.");
        haptic("light");
      });
    }

    var upgradeBtn = $("fiqUpgradeBtn");
    if (upgradeBtn) {
      upgradeBtn.addEventListener("click", function () {
        toast("⭐ FaceIQ Pro: безлимитные сканы, неограниченный Gemini 3.6 Flash и персональный план!");
        haptic("selection");
      });
    }
  }

  function bootApp() {
    bindChoices();
    bindDrop("front");
    bindDrop("profile");
    bindCta();
    bindViews();
    bindGpt();
    bindModalEvents();
    bindSidebar();
    bindCategoryTabs();
    bindShowMoreButtons();
    bindTopbarActions();
    preselect();
    initLoaderParallax();

    $("ctaBtn").addEventListener("pointerdown", createRipple);

    if (restoreSession()) {
      renderReport();
      setStep(4);
      window.setTimeout(function () {
        initMetricObserver();
        var frontImg = $("resultFront");
        if (frontImg) frontImg.classList.add("photo-reveal", "is-visible");
      }, 100);
      toast("Показан прошлый результат");
    } else {
      setStep(1);
    }

    window.addEventListener("resize", function () {
      window.clearTimeout(window._overlayTimer);
      window._overlayTimer = window.setTimeout(renderOverlay, 180);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
