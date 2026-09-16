// Printable report: the Print button. A separate file because the page's CSP
// forbids inline script. The report itself is rendered on the server.
(function () {
  var btn = document.getElementById('printReport');
  if (btn) btn.addEventListener('click', function () { window.print(); });
})();
