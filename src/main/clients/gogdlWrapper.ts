import { writeFileSync } from 'fs'
import { join } from 'path'
import { appConfigDir } from '../paths'

/**
 * Runs Heroic's gogdl with one fix: when a game ships both 64-bit and 32-bit depots, only
 * the 64-bit ones are installed. gogdl filters depots by language but ignores their
 * osBitness, so it downloaded BOTH builds into the same folder and whichever finished last
 * won - for CARRION the 32-bit files overwrote the 64-bit ones, and the 32-bit build's GOG
 * Galaxy wrapper lacks an export the game needs, so it crashed on start. Heroic's gogdl has
 * no option for this, so the wrapper patches the depot list before gogdl's own CLI runs.
 */
const WRAPPER = `import runpy, sys

gogdl = sys.argv[1]
sys.argv = [gogdl] + sys.argv[2:]
sys.path.insert(0, gogdl)

from gogdl.dl.objects import v2

_parse_depots = v2.Manifest.parse_depots

def parse_depots(self, language, depots):
    if any("64" in (d.get("osBitness") or []) for d in depots):
        depots = [d for d in depots if not d.get("osBitness") or "64" in d["osBitness"]]
    return _parse_depots(self, language, depots)

v2.Manifest.parse_depots = parse_depots
runpy.run_path(gogdl, run_name="__main__")
`

/** Writes the wrapper (refreshed every call, so app updates replace it) and returns the
 *  command prefix to run gogdl through it: ['python3', wrapper, gogdlBin]. */
export function gogdl64BitCommand(gogdlBin: string): { bin: string; prefixArgs: string[] } {
  const wrapper = join(appConfigDir(), 'gogdl-64bit.py')
  writeFileSync(wrapper, WRAPPER)
  return { bin: 'python3', prefixArgs: [wrapper, gogdlBin] }
}
