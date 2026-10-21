/* ==========================================================================
   Glimmerfell Projects – shared script (used by projects/index.html and every feature)
   - Builds the nav and footer once, so a menu change is made here only
   - Turns <figure data-video="..."> into the right player (YouTube, Vimeo, MP4, other)
   - Image lightbox, missing-image placeholders, scroll progress, custom cursor, back-to-top
   ========================================================================== */
(function () {
  /* ── 1. EDIT HERE: main-site address and menu ─────────────────────────── */
  var SITE = 'https://www.glimmerfell.com/';
  var HOME = 'index.html';            // projects home, relative to the projects folder
  var MENU = [
    ['Digital Twins',  SITE + '#demo'],
    ['The Problem',    SITE + '#evidence'],
    ['The Difference', SITE + '#difference'],
    ['How It Works',   SITE + '#process'],
    ['Credentials',    SITE + '#credentials'],
    ['Projects',       HOME, 'here']
  ];
  var CTA = ['Request a Demonstration', 'mailto:manny@glimmerfell.com'];
  /* ─────────────────────────────────────────────────────────────────────── */

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ── nav ── */
  var navSlot = $('#gf-nav');
  if (navSlot) {
    var links = MENU.map(function (m) {
      return '<a href="' + m[1] + '"' + (m[2] === 'here' ? ' aria-current="page"' : '') + '>' + m[0] + '</a>';
    }).join('') + '<a class="gf-cta" href="' + CTA[1] + '">' + CTA[0] + '</a>';
    navSlot.outerHTML =
      '<nav class="gf-nav" id="gfNav">' +
        '<a class="gf-brand" href="' + SITE + '"><img src="' + SITE + 'assets/logo.png" alt="Glimmerfell logo" onerror="this.style.opacity=0"><span>Glimmerfell</span></a>' +
        '<button class="gf-burger" aria-label="Menu" aria-expanded="false"><span></span><span></span><span></span></button>' +
        '<div class="gf-links">' + links + '</div>' +
        '<div class="gf-progress"><div id="gfProgress"></div></div>' +
      '</nav><div class="gf-spacer" id="gfSpacer"></div>';
  }
  var nav = $('#gfNav'), burger = nav && $('.gf-burger', nav), spacer = $('#gfSpacer');
  if (burger) burger.addEventListener('click', function () {
    var open = nav.classList.toggle('is-open');
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  if (nav) nav.addEventListener('click', function (e) {
    if (e.target.closest('.gf-links a')) { nav.classList.remove('is-open'); burger.setAttribute('aria-expanded', 'false'); }
  });
  function measureNav() { if (nav && spacer) spacer.style.height = Math.round(nav.getBoundingClientRect().height) + 'px'; }
  measureNav();
  if (window.ResizeObserver && nav) new ResizeObserver(measureNav).observe(nav);

  /* ── footer ── */
  var footSlot = $('#gf-footer');
  if (footSlot) {
    footSlot.outerHTML =
      '<footer class="gf-footer"><div class="cols">' +
        '<div><h3>Glimmerfell</h3><p>Glimmerfell transforms architectural data into interactive 1:1 scale digital twins that let buyers, planners and communities see a development before it is built, for off-plan pre-sales and planning approvals. Built to feature-film and regulated-industry production standards.</p></div>' +
        '<div><h4>Explore</h4><ul>' + MENU.map(function (m) { return '<li><a href="' + m[1] + '">' + (m[0] === 'Credentials' ? 'Production Credentials' : m[0]) + '</a></li>'; }).join('') + '</ul></div>' +
        '<div><h4>Contact</h4><p style="margin-bottom:18px;max-width:34ch">Ready to remove spatial ambiguity from your next development?</p><ul>' +
          '<li><a href="mailto:manny@glimmerfell.com" style="border-bottom:1px solid rgba(197,160,89,.5);padding-bottom:2px">Email</a></li>' +
          '<li><a href="' + SITE + '">www.glimmerfell.com</a></li><li>New Zealand · Working internationally</li></ul></div>' +
      '</div><div class="base"><div>© ' + new Date().getFullYear() + ' Glimmerfell Ltd. All rights reserved.</div><div>Digital Twin Sales Platform · 1:1 scale from your drawings · VR ready</div></div></footer>';
  }

  /* ── chrome: cursor, ripple, lightbox, back-to-top ── */
  document.body.insertAdjacentHTML('beforeend',
    '<div id="gfRing" aria-hidden="true"></div><div id="gfRipple" aria-hidden="true"></div>' +
    '<div id="gfLightbox" role="dialog" aria-label="Enlarged image"><button aria-label="Close">&times;</button><img alt=""></div>' +
    '<button id="gfTop" aria-label="Back to top"><svg viewBox="0 0 24 24"><path d="M12 4l-8 8h5v8h6v-8h5z"/></svg></button>');

  /* ── video embeds: <figure data-video="URL"> ──
     Optional attributes on the figure:
       data-ratio="9:16"     aspect ratio (default 16:9; YouTube Shorts default 9:16)
       data-poster="x.jpg"   still frame shown before an MP4 plays
       data-loop             silent autoplaying loop, no controls (for animation loops)
       data-start="45"       YouTube/Vimeo start time in seconds                      */
  function player(url, fig) {
    var m, start = parseInt(fig.getAttribute('data-start') || '0', 10);
    if ((m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/))) {
      if (/shorts\//.test(url) && !fig.hasAttribute('data-ratio')) fig.setAttribute('data-ratio', '9:16');
      return '<iframe src="https://www.youtube-nocookie.com/embed/' + m[1] + '?rel=0&modestbranding=1' + (start ? '&start=' + start : '') +
        '" title="YouTube video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>';
    }
    if ((m = url.match(/vimeo\.com\/(?:video\/)?(\d+)(?:\/([\da-f]+))?/))) {
      return '<iframe src="https://player.vimeo.com/video/' + m[1] + '?dnt=1' + (m[2] ? '&h=' + m[2] : '') + (start ? '#t=' + start + 's' : '') +
        '" title="Vimeo video" loading="lazy" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>';
    }
    if (/\.(mp4|webm|m4v|mov)(\?|#|$)/i.test(url)) {
      var poster = fig.getAttribute('data-poster'), loop = fig.hasAttribute('data-loop');
      return '<video src="' + url + '"' + (poster ? ' poster="' + poster + '"' : '') +
        (loop ? ' autoplay muted loop playsinline' : ' controls playsinline') + ' preload="metadata"></video>';
    }
    if (/^https?:\/\//.test(url)) return '<iframe src="' + url + '" title="Embedded media" loading="lazy" allow="fullscreen; xr-spatial-tracking" allowfullscreen></iframe>';
    return null;
  }
  $$('figure[data-video]').forEach(function (fig) {
    var url = (fig.getAttribute('data-video') || '').trim(), html = url ? player(url, fig) : null;
    var box = document.createElement('div');
    if (!url) { box.className = 'frame frame-soon'; box.textContent = fig.getAttribute('data-soon') || 'Film in production'; }
    else if (!html) { box.className = 'media-error'; box.textContent = 'Video link not recognised: ' + url; }
    else {
      box.className = 'frame'; box.innerHTML = html;
      var r = (fig.getAttribute('data-ratio') || '16:9').split(':');
      box.style.aspectRatio = (parseFloat(r[0]) || 16) + ' / ' + (parseFloat(r[1]) || 9);
      if (fig.hasAttribute('data-loop')) box.setAttribute('data-cursor', '');
    }
    fig.insertBefore(box, fig.firstChild);
  });
  if (reduced) $$('video[autoplay]').forEach(function (v) { v.removeAttribute('autoplay'); v.controls = true; v.pause(); });

  /* ── lightbox for post images ── */
  var lb = $('#gfLightbox'), lbImg = $('img', lb);
  function closeLb() { lb.classList.remove('is-open'); lbImg.removeAttribute('src'); document.body.style.overflow = ''; }
  $$('.post-body figure img').forEach(function (img) {
    if (img.closest('a')) return;
    img.setAttribute('data-cursor', 'View');
    img.addEventListener('click', function () {
      lbImg.src = img.getAttribute('data-full') || img.currentSrc || img.src; lbImg.alt = img.alt;
      lb.classList.add('is-open'); document.body.style.overflow = 'hidden';
    });
  });
  lb.addEventListener('click', closeLb);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeLb(); if (nav) nav.classList.remove('is-open'); } });

  /* ── image not added yet: show a labelled placeholder instead of a broken icon ── */
  $$('.post-body img, .cover img, .thumb img').forEach(function (img) {
    function miss() { var f = img.closest('figure') || img.parentNode; f.classList.add('is-missing');
      f.setAttribute('data-missing', 'Add image: ' + img.getAttribute('src')); }
    if (img.complete && !img.naturalWidth) miss(); else img.addEventListener('error', miss);
  });

  /* ── scroll reveal ── */
  var io = ('IntersectionObserver' in window && !reduced) ? new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -8% 0px', threshold: .06 }) : null;
  $$('[data-reveal]').forEach(function (el, i) {
    if (io) { el.style.transitionDelay = (i % 3) * 90 + 'ms'; io.observe(el); } else el.classList.add('is-in');
  });

  /* ── custom cursor + touch ripple ── */
  var ring = $('#gfRing'), ripple = $('#gfRipple');
  var fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  function idle() { ring.style.width = ring.style.height = '7px'; ring.style.margin = '-3.5px 0 0 -3.5px';
    ring.style.backgroundColor = '#c5a059'; ring.style.borderColor = 'rgba(197,160,89,0)'; ring.textContent = ''; }
  function grow(label) { var s = label ? 84 : 56; ring.style.width = ring.style.height = s + 'px'; ring.style.margin = (-s / 2) + 'px 0 0 ' + (-s / 2) + 'px';
    ring.style.backgroundColor = 'rgba(197,160,89,0.16)'; ring.style.borderColor = 'rgba(197,160,89,0.95)'; ring.textContent = label || ''; }
  var overFrame = false;
  if (fine && !reduced) {
    ring.style.display = 'flex'; document.body.setAttribute('data-gf-cursor', 'on');
    document.addEventListener('pointermove', function (e) {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      ring.style.transform = 'translate3d(' + e.clientX + 'px,' + e.clientY + 'px,0)';
    }, { passive: true });
    document.addEventListener('pointerover', function (e) {
      var hit = e.target.closest('[data-cursor],a,button');
      if (hit) grow(hit.getAttribute('data-cursor') || ''); else idle();
    }, { passive: true });
    /* players inside iframes need the normal cursor back */
    $$('.post-body .frame').forEach(function (f) {
      if (!f.querySelector('iframe, video[controls]')) return;
      f.addEventListener('mouseenter', function () { ring.style.opacity = '0'; document.body.removeAttribute('data-gf-cursor'); });
      f.addEventListener('mouseleave', function () { ring.style.opacity = '1'; document.body.setAttribute('data-gf-cursor', 'on'); });
    });
  }
  document.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' || reduced) return;
    ripple.style.transition = 'none'; ripple.style.opacity = '.95';
    ripple.style.transform = 'translate3d(' + e.clientX + 'px,' + e.clientY + 'px,0) scale(.25)';
    requestAnimationFrame(function () {
      ripple.style.transition = 'transform .55s cubic-bezier(.16,1,.3,1), opacity .55s ease-out';
      ripple.style.opacity = '0'; ripple.style.transform = 'translate3d(' + e.clientX + 'px,' + e.clientY + 'px,0) scale(1.35)';
    });
  }, { passive: true });

  /* ── scroll progress + back to top ── */
  var progress = $('#gfProgress'), top = $('#gfTop'), raf = null;
  top.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' }); });
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = null;
      var d = document.documentElement, max = d.scrollHeight - innerHeight, y = scrollY || d.scrollTop || 0;
      if (progress) progress.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, y / max) : 0) + ')';
      top.classList.toggle('is-on', y > 300);
    });
  }
  addEventListener('scroll', onScroll, { passive: true }); addEventListener('resize', onScroll, { passive: true }); onScroll();
})();
