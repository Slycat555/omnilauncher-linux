import { useAppStore } from '../store'

/** Full-screen "Launching…" overlay shown briefly when an NFC tag scan launches a game
 *  - large cover art and title, Zaparoo-style, instead of a small toast easy to miss. */
export function NfcLaunchOverlay(): React.JSX.Element | null {
  const gameId = useAppStore((s) => s.nfcLaunchGameId)
  const games = useAppStore((s) => s.games)
  const cover = useAppStore((s) => (gameId ? s.covers[gameId] : undefined))

  if (!gameId) return null
  const game = games.find((g) => g.id === gameId)
  if (!game) return null

  // Deliberately the same field GameCard uses for its thumbnail (not hero) - so the
  // launch overlay always shows exactly the art the user already sees on the card,
  // never a different/missing image.
  const art = cover?.cover

  return (
    <div className="nfc-launch-overlay">
      <div className="nfc-launch-card">
        {art ? (
          <img className="nfc-launch-art" src={art} alt="" />
        ) : (
          <div className="nfc-launch-art nfc-launch-art-empty" />
        )}
        <div className="nfc-launch-label">Launching</div>
        <div className="nfc-launch-title">{game.title}</div>
      </div>
    </div>
  )
}
