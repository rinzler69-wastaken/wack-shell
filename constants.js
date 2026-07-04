export const SymbolicDistroIcons = [
    { PATH: 'start-here-symbolic' },                 // Default (index 0)
    { PATH: '/Resources/apple-icon-symbolic.svg' }, // Apple (Wackintosh) (index 1)
    { PATH: '/Resources/fedora-logo-symbolic.svg' }, // Fedora (index 2)
    { PATH: '/Resources/debian-logo-symbolic.svg' }, // Debian (index 3)
    { PATH: '/Resources/manjaro-logo-symbolic.svg' },// Manjaro (index 4)
    { PATH: '/Resources/pop-os-logo-symbolic.svg' }, // Pop!_OS (index 5)
    { PATH: '/Resources/ubuntu-logo-symbolic.svg' }, // Ubuntu (index 6)
    { PATH: '/Resources/arch-logo-symbolic.svg' },   // Arch Linux (index 7)
    { PATH: '/Resources/opensuse-logo-symbolic.svg' },// openSUSE (index 8)
    { PATH: '/Resources/raspbian-logo-symbolic.svg' },// Raspbian (index 9)
    { PATH: '/Resources/kali-linux-logo-symbolic.svg' },// Kali Linux (index 10)
    { PATH: '/Resources/pureos-logo-symbolic.svg' },  // PureOS (index 11)
    { PATH: '/Resources/solus-logo-symbolic.svg' },   // Solus (index 12)
    { PATH: '/Resources/budgie-logo-symbolic.svg' },  // Budgie (index 13)
    { PATH: '/Resources/gentoo-logo-symbolic.svg' },  // Gentoo (index 14)
    { PATH: '/Resources/mx-logo-symbolic.svg' },      // MX Linux (index 15)
    { PATH: '/Resources/redhat-logo-symbolic.svg' },  // Red Hat (index 16)
    { PATH: '/Resources/voyager-logo-symbolic.svg' },  // Voyager (index 17)
    { PATH: '/Resources/garuda-logo-symbolic.svg' },  // Garuda (index 18)
    { PATH: '/Resources/freebsd-logo-symbolic.svg' }, // FreeBSD (index 19)
    { PATH: '/Resources/tux-logo-symbolic.svg' },     // Tux (Linux) (index 20)
    { PATH: '/Resources/rockylinux-logo-symbolic.svg' },// Rocky Linux (index 21)
    { PATH: '/Resources/endeavouros_logo-symbolic.svg' },// EndeavourOS (index 22)
    { PATH: '/Resources/almalinux-logo-symbolic.svg' },// AlmaLinux (index 23)
    { PATH: '/Resources/nixos-logo-symbolic.svg' },   // NixOS (index 24)
    { PATH: '/Resources/shastraos-logo-symbolic.svg' },// ShastraOS (index 25)
    { PATH: '/Resources/asahilinux-logo-symbolic.svg' },// Asahi Linux (index 26)
    { PATH: '/Resources/zorin-logo-symbolic.svg' },   // Zorin OS (index 27)
    { PATH: '/Resources/void-logo-symbolic.svg' },    // Void Linux (index 28)
    { PATH: '/Resources/nobara-logo-symbolic.svg' },  // Nobara (index 29)
    { PATH: '/Resources/steam-deck-logo-symbolic.svg' },// Steam Deck (index 30)
    { PATH: '/Resources/ublue-logo-symbolic.svg' },   // Ublue (index 31)
    { PATH: '/Resources/centos-logo-symbolic.svg' },  // CentOS (index 32)
    { PATH: '/Resources/cachyos-logo-symbolic.svg' },  // CachyOS (index 33)
];

export const ColouredDistroIcons = [
    { PATH: 'start-here-symbolic' },                 // Default (index 0)
    { PATH: '/Resources/apple-icon-symbolic.svg' }, // Apple (Wackintosh) (index 1)
    { PATH: '/Resources/fedora-logo.svg' },          // Fedora (index 2)
    { PATH: '/Resources/debian-logo.svg' },          // Debian (index 3)
    { PATH: '/Resources/manjaro-logo.svg' },         // Manjaro (index 4)
    { PATH: '/Resources/pop-os-logo.svg' },          // Pop!_OS (index 5)
    { PATH: '/Resources/ubuntu-logo.svg' },          // Ubuntu (index 6)
    { PATH: '/Resources/arch-logo.svg' },            // Arch Linux (index 7)
    { PATH: '/Resources/opensuse-logo.svg' },         // openSUSE (index 8)
    { PATH: '/Resources/raspbian-logo-symbolic.svg' },// Raspbian fallback (index 9)
    { PATH: '/Resources/kali-linux-logo.svg' },      // Kali Linux (index 10)
    { PATH: '/Resources/pureos-logo-symbolic.svg' },  // PureOS fallback (index 11)
    { PATH: '/Resources/solus-logo.svg' },           // Solus (index 12)
    { PATH: '/Resources/budgie-logo-symbolic.svg' },  // Budgie fallback (index 13)
    { PATH: '/Resources/gentoo-logo.svg' },          // Gentoo (index 14)
    { PATH: '/Resources/mx-logo-symbolic.svg' },      // MX Linux fallback (index 15)
    { PATH: '/Resources/redhat-logo.svg' },          // Red Hat (index 16)
    { PATH: '/Resources/voyager-logo-symbolic.svg' },  // Voyager fallback (index 17)
    { PATH: '/Resources/garuda-logo-symbolic.svg' },  // Garuda fallback (index 18)
    { PATH: '/Resources/freebsd-logo.svg' },         // FreeBSD (index 19)
    { PATH: '/Resources/tux-logo.svg' },             // Tux (Linux) (index 20)
    { PATH: '/Resources/rockylinux-logo.svg' },      // Rocky Linux (index 21)
    { PATH: '/Resources/endeavouros_logo.svg' },     // EndeavourOS (index 22)
    { PATH: '/Resources/almalinux-logo.svg' },       // AlmaLinux (index 23)
    { PATH: '/Resources/nixos-logo.svg' },          // NixOS (index 24)
    { PATH: '/Resources/shastraos-logo.svg' },       // ShastraOS (index 25)
    { PATH: '/Resources/asahilinux-logo.svg' },      // Asahi Linux (index 26)
    { PATH: '/Resources/zorin-logo.svg' },           // Zorin OS (index 27)
    { PATH: '/Resources/void-logo.svg' },            // Void Linux (index 28)
    { PATH: '/Resources/nobara-logo-symbolic.svg' },  // Nobara fallback (index 29)
    { PATH: '/Resources/steam-deck-logo.svg' },      // Steam Deck (index 30)
    { PATH: '/Resources/ublue-logo.svg' },           // Ublue (index 31)
    { PATH: '/Resources/centos-logo.svg' },          // CentOS (index 32)
    { PATH: '/Resources/cachyos-logo.svg' },         // CachyOS (index 33)
];

export function clamp(val, min, max) {
    return Math.max(min, Math.min(val, max));
}

export function parseColorStringToRgb(str) {
    if (!str) return { r: 0, g: 0, b: 0 };
    const cleanedStr = str.trim();
    if (cleanedStr.startsWith('#')) {
        const cleaned = cleanedStr.replace('#', '');
        if (cleaned.length === 3) {
            return {
                r: parseInt(cleaned[0] + cleaned[0], 16),
                g: parseInt(cleaned[1] + cleaned[1], 16),
                b: parseInt(cleaned[2] + cleaned[2], 16)
            };
        } else if (cleaned.length === 6) {
            return {
                r: parseInt(cleaned.substring(0, 2), 16),
                g: parseInt(cleaned.substring(2, 4), 16),
                b: parseInt(cleaned.substring(4, 6), 16)
            };
        }
    }
    const match = cleanedStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
        return {
            r: parseInt(match[1], 10),
            g: parseInt(match[2], 10),
            b: parseInt(match[3], 10)
        };
    }
    return { r: 0, g: 0, b: 0 };
}

export function getLuminance(r, g, b) {
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0;
}

export const DISTRO_LOGOS = [
    "Default",
    "Apple (Wackintosh)",
    "Fedora",
    "Debian",
    "Manjaro",
    "Pop!_OS",
    "Ubuntu",
    "Arch Linux",
    "openSUSE",
    "Raspbian",
    "Kali Linux",
    "PureOS",
    "Solus",
    "Budgie",
    "Gentoo",
    "MX Linux",
    "Red Hat",
    "Voyager",
    "Garuda",
    "FreeBSD",
    "Tux (Linux)",
    "Rocky Linux",
    "EndeavourOS",
    "AlmaLinux",
    "NixOS",
    "ShastraOS",
    "Asahi Linux",
    "Zorin OS",
    "Void Linux",
    "Nobara",
    "Steam Deck",
    "Ublue",
    "CentOS",
    "CachyOS"
];

// ─── Tunable: workspace thumbnail height in App Grid state ────────────────────
// GNOME's built-in value is 0.15 (15% of the overview height).
// Lower values give the app grid more vertical room when workspace view is ON.
// When 'Disable Workspace View in App Grid' is ON the workspace is hidden via
// opacity anyway, but this ratio still governs the hidden reserved area.
// Accepted range: 0.001 – 0.15. Change and reload to fine-tune.
export const APP_GRID_WORKSPACE_RATIO = 0.001;
// ─────────────────────────────────────────────────────────────────────────────
