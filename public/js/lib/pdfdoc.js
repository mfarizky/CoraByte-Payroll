/**
 * CoraByte Payroll — PDF export, in the browser.
 * The payslip / remittance page is rendered off-screen, captured with
 * html2canvas and placed on an A4 page with jsPDF (both self-hosted in
 * /vendor). The PDF is an image of the page, so its text is not selectable.
 *   GKI.pdfdoc.payslipPdf(data) / remittancePdf(spec) -> Promise<Blob>
 *   GKI.pdfdoc.download(blob, name), .base64(blob)
 */
(function () {
  'use strict';

  var H2C = '/vendor/html2canvas.min.js';   // html2canvas 1.4.1 (MIT), self-hosted
  var JSPDF = '/vendor/jspdf.umd.min.js';    // jsPDF 2.5.1 (MIT), self-hosted
  var SCALE = 2, JPEG_Q = 0.92;

  var loads = {};
  function script(src, ready) {
    if (ready()) return Promise.resolve();
    if (!loads[src]) loads[src] = new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = function () { ready() ? ok() : bad(new Error('The PDF library did not load.')); };
      s.onerror = function () { delete loads[src]; bad(new Error('The PDF library could not be loaded. Reload the page and try again.')); };
      document.head.appendChild(s);
    });
    return loads[src];
  }
  function libs() {
    return Promise.all([
      script(H2C, function () { return !!window.html2canvas; }),
      script(JSPDF, function () { return !!(window.jspdf && window.jspdf.jsPDF); })
    ]);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* The inside of <body> of a full HTML document (payslip.html returns one). */
  function bodyOf(docHtml) {
    var m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(String(docHtml));
    return m ? m[1] : String(docHtml);
  }

  /* One A4 .ps-pg → PDF Blob. */
  function pageToPdf(innerHtml) {
    return libs().then(function () {
      var host = document.createElement('div');
      host.className = 'ps-body';
      host.setAttribute('aria-hidden', 'true');
      host.style.position = 'fixed'; host.style.left = '-10000px'; host.style.top = '0';
      host.style.pointerEvents = 'none';
      host.innerHTML = innerHtml;
      document.body.appendChild(host);
      var pg = host.querySelector('.ps-pg') || host;
      var imgs = Array.prototype.slice.call(host.querySelectorAll('img')).map(function (im) {
        return im.complete ? null : new Promise(function (r) { im.onload = im.onerror = r; });
      }).filter(Boolean);
      var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
      var bg = getComputedStyle(document.documentElement).getPropertyValue('--pr-slip-paper').trim() || null;
      return Promise.all([fonts].concat(imgs)).then(function () {
        return window.html2canvas(pg, { scale: SCALE, useCORS: true, backgroundColor: bg, logging: false });
      }).then(function (canvas) {
        var pdf = new window.jspdf.jsPDF({ orientation: 'p', unit: 'mm', format: 'a4', compress: true });
        pdf.addImage(canvas.toDataURL('image/jpeg', JPEG_Q), 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
        return pdf.output('blob');
      }).then(function (blob) {
        host.parentNode.removeChild(host);
        return blob;
      }, function (err) {
        if (host.parentNode) host.parentNode.removeChild(host);
        throw new Error('The PDF could not be made: ' + (err && err.message ? err.message : 'unknown error') + '.');
      });
    });
  }

  /* The remittance page, from outputs.js's remSpec — the .ps-* / .rm-* classes
     remittanceDoc used (app.css), so it looks like the payslip family. */
  function remittanceHtml(spec) {
    var rows = (spec.rows || []).map(function (r) {
      var cls = r.kind === 'h' ? ' class="rm-h"' : r.kind === 't' ? ' class="ps-t"' : '';
      return '<tr' + cls + '><td>' + esc(r.c[0]) + '</td><td class="ps-n">' + esc(r.c[1]) + '</td><td class="ps-n">' +
        esc(r.c[2]) + '</td></tr>';
    }).join('');
    return '<div class="ps-pg">' +
      '<div class="ps-hd"><div class="ps-co"><div><b>' + esc(spec.legalUpper) + '</b>' +
      '<span>' + (spec.npwp ? 'NPWP ' + esc(spec.npwp) : '') + '</span></div></div>' +
      '<div class="ps-tt"><b>REMITTANCE · TO PAY</b><strong>' + esc(spec.period) + '</strong></div></div>' +
      '<div class="rm"><table>' + rows + '</table>' +
      '<div class="ps-net"><span>TOTAL TO REMIT</span><b><small>Rp</small>' + esc(spec.total) + '</b></div>' +
      '<div class="ps-note">' + esc(spec.note) + '</div></div>' +
      '<div class="ps-foot"><span>' + esc(spec.legal) + '</span><span>Dibuat ' + esc(spec.made) + '</span><span></span></div>' +
      '</div>';
  }

  function base64(blob) {
    return new Promise(function (ok, bad) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result).split(',')[1]); };
      r.onerror = function () { bad(new Error('The file could not be read.')); };
      r.readAsDataURL(blob);
    });
  }

  /* public: the payslip / remittance as a PDF Blob */
  function payslipPdf(d) {
    return pageToPdf(bodyOf(window.GKI.payslip.html(d, location.origin + '/')));
  }
  function remittancePdf(spec) {
    return pageToPdf(remittanceHtml(spec));
  }
  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.parentNode.removeChild(a); }, 1000);
  }

  if (!window.GKI) window.GKI = {};
  window.GKI.pdfdoc = { payslipPdf: payslipPdf, remittancePdf: remittancePdf, download: download, base64: base64,
                        remittanceHtml: remittanceHtml };
}());
