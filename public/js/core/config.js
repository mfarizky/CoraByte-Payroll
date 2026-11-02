/**
 * CoraByte Payroll — frontend configuration.
 * Loaded first; store.js and spine.js read window.GKI_CONFIG.
 */
(function () {
  'use strict';

  window.GKI_CONFIG = {
    APP: 'payroll',                 // namespace for the few things kept in this browser
    APP_NAME: 'CoraByte Payroll',
    BRAND: 'CoraByte',
    MODULE: 'Payroll',
    VERSION: '0.3.0',

    BRANDING: {
      accent: '#014A7F'             // the active/selected colour (--gki-module)
    },

    /* Left navigation, in order. adminOnly tabs are hidden from members. */
    TABS: [
      { id: 'home',      label: 'Home' },
      { id: 'employees', label: 'Employees' },
      { id: 'run',       label: 'Payroll run' },
      { id: 'users',     label: 'Users', adminOnly: true },
      { id: 'settings',  label: 'Settings' }
    ],

    /* Payroll dates ("today", effective dates) are read on this clock. */
    TIME_ZONE: 'Asia/Makassar'
  };
})();
