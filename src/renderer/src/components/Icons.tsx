type IconProps = { size?: number }

function base(children: React.ReactNode, size = 16): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

export const SearchIcon = ({ size }: IconProps): React.JSX.Element =>
  base(
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>,
    size
  )

export const RefreshIcon = ({ size }: IconProps): React.JSX.Element =>
  base(
    <>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </>,
    size
  )

export const SettingsIcon = ({ size }: IconProps): React.JSX.Element =>
  base(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>,
    size
  )

export const PlayIcon = ({ size }: IconProps): React.JSX.Element =>
  base(<polygon points="6 3 20 12 6 21 6 3" />, size)

export const DownloadIcon = ({ size }: IconProps): React.JSX.Element =>
  base(
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>,
    size
  )

export const TrashIcon = ({ size }: IconProps): React.JSX.Element =>
  base(
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>,
    size
  )

export const XIcon = ({ size }: IconProps): React.JSX.Element =>
  base(
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>,
    size
  )

export const TerminalIcon = ({ size }: IconProps): React.JSX.Element =>
  base(
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </>,
    size
  )

export const FolderIcon = ({ size }: IconProps): React.JSX.Element =>
  base(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />, size)

export const GridIcon = ({ size }: IconProps): React.JSX.Element =>
  base(
    <>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </>,
    size
  )

export const StopIcon = ({ size }: IconProps): React.JSX.Element => base(<rect x="5" y="5" width="14" height="14" />, size)

export const CheckIcon = ({ size }: IconProps): React.JSX.Element =>
  base(<polyline points="20 6 9 17 4 12" />, size)

export const ImageIcon = ({ size }: IconProps): React.JSX.Element =>
  base(
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </>,
    size
  )

export const NfcIcon = ({ size }: IconProps): React.JSX.Element =>
  base(
    <>
      <rect x="3" y="7" width="7" height="10" rx="1.5" />
      <path d="M13 8a5 5 0 0 1 0 8" />
      <path d="M16.5 5.5a9.5 9.5 0 0 1 0 13" />
      <path d="M20 3a13.5 13.5 0 0 1 0 18" />
    </>,
    size
  )

// Custom titlebar window-control glyphs (App.tsx) - the window is frameless, so these
// stand in for whatever the OS's own minimize/maximize/close buttons would have drawn.
export const MinimizeIcon = ({ size }: IconProps): React.JSX.Element =>
  base(<line x1="5" y1="12" x2="19" y2="12" />, size)

export const MaximizeIcon = ({ size }: IconProps): React.JSX.Element =>
  base(<rect x="5" y="5" width="14" height="14" rx="1" />, size)

/** Shown instead of MaximizeIcon once the window is already maximized - clicking
 *  restores it back down, same convention as every other OS's own window controls. */
export const RestoreIcon = ({ size }: IconProps): React.JSX.Element =>
  base(
    <>
      <rect x="7.5" y="4.5" width="12" height="12" rx="1" />
      <path d="M4.5 7.5v11a1 1 0 0 0 1 1h11" />
    </>,
    size
  )

