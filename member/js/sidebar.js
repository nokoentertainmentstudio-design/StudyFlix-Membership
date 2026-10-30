(function () {
  'use strict';

  const SIDEBAR_PLACEHOLDER_ID = 'sidebar-placeholder';
  const SIDEBAR_PATH = 'sidebar.html';

  async function loadSidebar() {
    const placeholder = document.getElementById(SIDEBAR_PLACEHOLDER_ID);
    if (!placeholder) return;

    try {
      const response = await fetch(SIDEBAR_PATH);
      const html = await response.text();
      placeholder.innerHTML = html;
      initSidebar();
    } catch (err) {
      console.error('Failed to load sidebar:', err);
    }
  }

  function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebarClose = document.getElementById('sidebarClose');
    const overlay = document.getElementById('sidebarOverlay');

    if (!sidebar) return;

    // Open sidebar (mobile)
    if (sidebarToggle) {
      sidebarToggle.addEventListener('click', () => {
        sidebar.classList.add('open');
        if (overlay) overlay.classList.add('active');
      });
    }

    // Close sidebar
    function closeSidebar() {
      sidebar.classList.remove('open');
      if (overlay) overlay.classList.remove('active');
    }

    if (sidebarClose) sidebarClose.addEventListener('click', closeSidebar);
    if (overlay) overlay.addEventListener('click', closeSidebar);

    // Highlight active link based on current page
    const currentPath = window.location.pathname.split('/').pop() || 'index.html';
    const links = sidebar.querySelectorAll('.sidebar-link');
    links.forEach(link => {
      const page = link.getAttribute('data-page');
      if (page === currentPath) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });
  }

  // Load when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadSidebar);
  } else {
    loadSidebar();
  }

  // Expose a small API if needed
  window.StudyFlixSidebar = {
    load: loadSidebar,
    close: function () {
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('sidebarOverlay');
      if (sidebar) sidebar.classList.remove('open');
      if (overlay) overlay.classList.remove('active');
    }
  };
})();