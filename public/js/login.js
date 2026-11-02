/**
 * CoraByte Payroll — sign-in and organisation registration.
 * A brand-new installation shows only the registration form (first-run setup).
 */
(function () {
  'use strict';

  var loginForm = document.getElementById('login-form');
  var registerForm = document.getElementById('register-form');
  var state = { needsSetup: false, allowSignup: false };

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (t) {
        if (!r.ok) throw new Error(t || 'Something went wrong (' + r.status + ').');
        return t ? JSON.parse(t) : null;
      });
    });
  }

  function values(form) {
    var out = {};
    Array.prototype.forEach.call(form.elements, function (i) { if (i.name) out[i.name] = i.value; });
    return out;
  }

  function wire(form, submit) {
    var error = form.querySelector('.auth-error');
    var button = form.querySelector('button[type=submit]');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      error.textContent = '';
      button.disabled = true;
      Promise.resolve()
        .then(function () { return submit(values(form)); })
        .then(function () { window.location.href = '/'; })
        .catch(function (err) { error.textContent = err.message; button.disabled = false; });
    });
  }

  function show(which) {
    var register = which === 'register' && (state.allowSignup || state.needsSetup);
    loginForm.hidden = register;
    registerForm.hidden = !register;
    document.getElementById('to-register').hidden = !state.allowSignup;
    document.getElementById('to-login').hidden = state.needsSetup;
    if (state.needsSetup) {
      document.getElementById('register-title').textContent = 'Welcome';
      document.getElementById('register-sub').textContent =
        'This is a new installation. Register your organization to start — you become its admin.';
    }
    (register ? registerForm : loginForm).querySelector('input').focus();
  }

  wire(loginForm, function (v) {
    if (!v.username || !v.password) throw new Error('Enter your username and password.');
    return post('/api/auth/login', { username: v.username, password: v.password });
  });

  wire(registerForm, function (v) {
    if (v.password !== v.again) throw new Error('The two passwords are not the same.');
    return post('/api/auth/register', { org_name: v.org_name, name: v.name, username: v.username, password: v.password });
  });

  window.addEventListener('hashchange', function () { show(location.hash === '#register' ? 'register' : 'login'); });

  fetch('/api/auth/state', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (s) {
      if (s.user) { window.location.href = '/'; return; }
      state = s;
      show(s.needsSetup || location.hash === '#register' ? 'register' : 'login');
    })
    .catch(function () {
      loginForm.hidden = false;
      loginForm.querySelector('.auth-error').textContent = 'The server is not responding.';
    });
})();
