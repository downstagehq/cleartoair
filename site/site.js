/* Clear to Air - landing page behaviour. No dependencies; the only request is this site's own contacts.json. */
(function () {
  'use strict';

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* The public repo. Every repo button reads it; with it empty they stay on this page,
     because a link into a GitHub namespace nobody owns could be claimed by anyone.
     NB: the org is downstagehq. github.com/downstage is someone else's. */
  var REPO = 'downstagehq/cleartoair';
  /* The launch switch: the repo is private until Phase B, so its links would 404 for a
     visitor. Set to true when downstagehq/cleartoair is public. */
  var REPO_PUBLIC = true;
  var repoLinks = document.querySelectorAll('[data-repo-path]');
  for (var r = 0; r < repoLinks.length; r++) {
    var a = repoLinks[r];
    if (REPO_PUBLIC && /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(REPO) && !/^owner\//i.test(REPO)) {
      a.href = 'https://github.com/' + REPO + a.getAttribute('data-repo-path');
    } else {
      a.title = 'The public repository opens at launch';
      if (a.hasAttribute('data-repo-soon')) a.textContent = a.getAttribute('data-repo-soon');
    }
  }

  /* Contact buttons read contacts.json, the one switch for every published address.
     Until "confirmed" is true (each mailbox has received a test mail) they stay on this
     page: nobody should be sent to an address that bounces. */
  var contactLinks = document.querySelectorAll('[data-contact]');
  function holdContacts() {
    for (var c = 0; c < contactLinks.length; c++) contactLinks[c].title = 'Contact details are being set up';
  }
  if (contactLinks.length && window.fetch) {
    fetch('contacts.json', { cache: 'no-store' }).then(function (res) { return res.ok ? res.json() : null; }).then(function (ct) {
      if (!ct || ct.confirmed !== true) return holdContacts();
      for (var c = 0; c < contactLinks.length; c++) {
        var el = contactLinks[c];
        var addr = ct[el.getAttribute('data-contact')];
        if (typeof addr !== 'string' || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(addr)) continue;
        var subject = el.getAttribute('data-contact-subject');
        el.href = 'mailto:' + addr + (subject ? '?subject=' + encodeURIComponent(subject) : '');
        el.removeAttribute('title');
      }
    }).catch(holdContacts);
  } else holdContacts();

  /* Lamp lights up 600 ms after load (brand signature). */
  function lightLamps() {
    ['lamp-nav', 'lamp-hero'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.add('is-ok');   /* the wordmark's ✓ lights: idle -> clear */
    });
  }
  window.addEventListener('load', function () { setTimeout(lightLamps, 600); });
  /* Belt and braces: if load already fired (cached), still light within 600 ms of script run. */
  if (document.readyState === 'complete') setTimeout(lightLamps, 600);

  /* Scale the fixed-size control-room mock to the width of its frame. */
  var cr = document.getElementById('cr');
  var fit = cr && cr.parentElement;
  function fitMock() {
    if (!cr || !fit) return;
    var w = cr.offsetWidth, h = cr.offsetHeight;
    var s = Math.min(1, fit.clientWidth / w);
    cr.style.transform = 'scale(' + s + ')';
    fit.style.height = Math.round(h * s) + 'px';
  }
  fitMock();
  window.addEventListener('resize', fitMock);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitMock);

  /* Live clock in the mock's status bar. */
  var clock = document.getElementById('cr-clock');
  function tick() {
    if (!clock) return;
    var d = new Date();
    clock.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(function (n) { return (n < 10 ? '0' : '') + n; }).join(':');
  }
  tick();
  setInterval(tick, 1000);

  /* "Get notified" form: posts to /api/early-access. Never claims success it cannot back up. */
  var form = document.getElementById('ea-form');
  var msg = document.getElementById('ea-msg');
  if (form && msg) {
    var btn = form.querySelector('button[type=submit]');
    var btnText = btn ? btn.textContent : '';

    function say(text, tone) {
      msg.hidden = false;
      msg.style.color = tone === 'bad' ? 'var(--warn)' : '';
      msg.textContent = text;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = form.querySelector('input[type=email]');
      var v = (input.value || '').trim();
      if (!v || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
        say('That does not look like an email address.', 'bad');
        input.focus();
        return;
      }

      if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
      say('Sending…');

      fetch('/api/early-access', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: v,
          company: (form.querySelector('input[name=company]') || {}).value || '',
          ref: document.referrer || ''
        })
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d || {} }; }); })
        .then(function (res) {
          if (res.ok && res.d.ok) {
            say('Done. We will email you once, at 1.0.');
            input.value = '';
            input.blur();
          } else if (res.d.code === 'unconfigured') {
            say('Sign-ups are not open yet, so nothing was stored. Try again later.', 'bad');
          } else {
            say(res.d.error || 'We could not record that just now. Please try again.', 'bad');
          }
        })
        .catch(function () {
          say('No connection, so nothing was sent. Please try again.', 'bad');
        })
        .then(function () {
          if (btn) { btn.disabled = false; btn.textContent = btnText; }
        });
    });
  }

  /* Scroll reveal. */
  var items = document.querySelectorAll('.reveal');
  if (reduce || !('IntersectionObserver' in window)) {
    items.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(function (el) { io.observe(el); });
  }
})();
