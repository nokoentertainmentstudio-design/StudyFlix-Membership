
(function (global) {
    'use strict';

    const NAV_ITEMS = [
        { id: 'dashboard',   label: 'Dashboard',   icon: 'fa-gauge-high',      href: 'admin-dashboard.html' },
        { id: 'members',     label: 'Members',     icon: 'fa-users',           href: 'admin-members.html' },
        { id: 'applications',label: 'Applications',icon: 'fa-file-lines',      href: 'admin-applications.html' },
        { id: 'payments',    label: 'Payments',    icon: 'fa-credit-card',     href: 'admin-payments.html' },
        { id: 'content',     label: 'Content',     icon: 'fa-photo-film',      href: 'admin-content.html' },
        { id: 'settings',    label: 'Settings',    icon: 'fa-gear',            href: 'admin-settings.html' }
    ];

    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function render(opts) {
        const options = Object.assign({
            mount: '#adminSidebar',
            active: 'dashboard',
            adminName: 'Admin',
            adminEmail: '',
            onLogout: null
        }, opts || {});

        const mount = document.querySelector(options.mount);
        if (!mount) {
            console.warn('AdminSidebar: mount target not found:', options.mount);
            return;
        }

        const name    = escapeHtml(options.adminName || 'Admin');
        const email   = escapeHtml(options.adminEmail || '');
        const initial = (options.adminName || 'A').trim().charAt(0).toUpperCase();

        const linksHtml = NAV_ITEMS.map(item => {
            const isActive = item.id === options.active;
            return `
                <a href="${item.href}" class="admin-sidebar-link${isActive ? ' is-active' : ''}">
                    <i class="fas ${item.icon}"></i>
                    <span>${escapeHtml(item.label)}</span>
                </a>
            `;
        }).join('');

        mount.innerHTML = `
            <div class="admin-sidebar-overlay" id="adminSidebarOverlay"></div>

            <div class="admin-sidebar-inner" id="adminSidebarInner">
                <div class="admin-sidebar-header">
                    <div class="admin-sidebar-avatar">${escapeHtml(initial)}</div>
                    <div class="admin-sidebar-meta">
                        <div class="admin-sidebar-name">${name}</div>
                        <div class="admin-sidebar-email">${email}</div>
                    </div>
                </div>

                <nav class="admin-sidebar-nav">
                    ${linksHtml}
                </nav>

                <div class="admin-sidebar-footer">
                    <button type="button" class="admin-sidebar-logout" id="adminSidebarLogout">
                        <i class="fas fa-right-from-bracket"></i>
                        <span>Sign out</span>
                    </button>
                </div>
            </div>

            <button type="button" class="admin-sidebar-toggle" id="adminSidebarToggle" aria-label="Toggle sidebar">
                <i class="fas fa-bars"></i>
            </button>
        `;

        const inner   = mount.querySelector('#adminSidebarInner');
        const overlay = mount.querySelector('#adminSidebarOverlay');
        const toggle  = mount.querySelector('#adminSidebarToggle');
        const logout  = mount.querySelector('#adminSidebarLogout');

        function closeMobile() {
            inner.classList.remove('is-open');
            overlay.classList.remove('is-open');
        }

        toggle.addEventListener('click', () => {
            const open = inner.classList.toggle('is-open');
            overlay.classList.toggle('is-open', open);
        });

        overlay.addEventListener('click', closeMobile);

        logout.addEventListener('click', () => {
            if (typeof options.onLogout === 'function') {
                options.onLogout();
            } else {
                // Fallback: try Firebase if available
                if (global.firebase && firebase.auth) {
                    firebase.auth().signOut().finally(() => {
                        window.location.href = 'index.html';
                    });
                } else {
                    window.location.href = 'index.html';
                }
            }
        });

        // Close drawer when a nav link is clicked (mobile)
        mount.querySelectorAll('.admin-sidebar-link').forEach(a => {
            a.addEventListener('click', closeMobile);
        });
    }

    global.AdminSidebar = { render: render, items: NAV_ITEMS };

})(window);