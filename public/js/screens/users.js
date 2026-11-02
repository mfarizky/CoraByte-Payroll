/**
 * CoraByte Payroll — Users screen (admins only).
 * List, add, edit role/name, reset password, deactivate.
 * The server enforces every rule (at least one active admin, no self-demotion).
 */
(function () {
  'use strict';

  var S = window.GKI && window.GKI.spine;
  if (!S) return;
  var U = S.ui, el = U.el;

  var ROLES = [['member', 'Member — runs payroll, cannot delete runs or employees'],
               ['admin', 'Admin — everything, plus users and deletes']];

  function mount(pane) {
    var wrap = el('div');
    pane.appendChild(wrap);
    S.me().then(function (me) {
      if (!me || me.role !== 'admin') {
        wrap.appendChild(el('p', 'pr-msg bad', 'Only an admin can manage users.'));
        return;
      }
      load(wrap, me);
    });
  }

  function load(wrap, me) {
    U.clear(wrap);
    wrap.appendChild(el('p', 'pr-msg', 'Loading…'));
    U.api('GET', '/api/users').then(function (users) { draw(wrap, me, users); },
      function (err) { U.clear(wrap); wrap.appendChild(el('p', 'pr-msg bad', U.errText(err))); });
  }

  function draw(wrap, me, users) {
    U.clear(wrap);
    var card = el('div', 'pr-card pr-list');
    var h = el('h4');
    h.appendChild(el('span', null, 'USERS · ' + users.length));
    h.appendChild(el('span', null, users.filter(function (u) { return u.active; }).length + ' active'));
    card.appendChild(h);

    var top = el('div', 'pr-top pr-listtop');
    var add = el('button', 'pr-btn', '+ Add user');
    add.type = 'button';
    add.addEventListener('click', function () {
      U.form({
        title: 'Add user', ok: 'Add user',
        fields: [
          { name: 'name', label: 'NAME' },
          { name: 'username', label: 'USERNAME', placeholder: 'e.g. bulan' },
          { name: 'password', label: 'TEMPORARY PASSWORD · AT LEAST 8 CHARACTERS', type: 'password' },
          { name: 'role', label: 'ROLE', type: 'select', options: ROLES, value: 'member' }
        ],
        submit: function (v) { return U.api('POST', '/api/users', v); }
      }).then(function (r) { if (r) { S.toast('User added.'); load(wrap, me); } });
    });
    top.appendChild(add);
    card.appendChild(top);

    var list = el('div');
    users.forEach(function (u) {
      var row = el('div', 'pr-er');
      var av = el('span', 'pr-av', U.initials(u.name));
      row.appendChild(av);
      var who = el('div');
      who.appendChild(el('b', null, u.name + (u.id === me.id ? '  (you)' : '')));
      who.appendChild(el('span', null, u.username));
      var tags = el('div', 'pr-ertags');
      tags.appendChild(el('span', 'pr-chip ' + (u.active ? 'g' : 'n'), u.active ? 'ACTIVE' : 'INACTIVE'));
      tags.appendChild(el('span', 'pr-chip n', u.role === 'admin' ? 'ADMIN' : 'MEMBER'));
      who.appendChild(tags);
      row.appendChild(who);
      var edit = el('button', 'pr-btn2', 'Edit');
      edit.type = 'button';
      edit.style.marginLeft = 'auto';
      edit.addEventListener('click', function () { editUser(wrap, me, u); });
      row.appendChild(edit);
      list.appendChild(row);
    });
    card.appendChild(list);
    wrap.appendChild(card);
  }

  function editUser(wrap, me, u) {
    U.form({
      title: 'Edit ' + u.username, ok: 'Save',
      note: 'Leave the password empty to keep it. A new password or deactivation signs the user out.',
      fields: [
        { name: 'name', label: 'NAME', value: u.name },
        { name: 'role', label: 'ROLE', type: 'select', options: ROLES, value: u.role },
        { name: 'active', label: 'STATUS', type: 'select', options: [['1', 'Active'], ['0', 'Inactive — cannot sign in']],
          value: u.active ? '1' : '0' },
        { name: 'password', label: 'NEW PASSWORD · OPTIONAL', type: 'password' }
      ],
      submit: function (v) {
        var body = { name: v.name, role: v.role, active: v.active === '1' };
        if (v.password) body.password = v.password;
        return U.api('PUT', '/api/users/' + encodeURIComponent(u.id), body);
      }
    }).then(function (r) { if (r) { S.toast('Saved.'); load(wrap, me); } });
  }

  S.register({ id: 'users', label: 'Users', mount: mount });
}());
