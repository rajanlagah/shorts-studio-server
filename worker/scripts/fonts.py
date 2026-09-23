"""Build worker/fonts/ttf from google/fonts sources and write fonts/manifest.json.

  pip install fonttools
  python scripts/fonts.py --from <dir with google/fonts files>   # rebuild fonts/ttf + manifest
  python scripts/fonts.py                                         # manifest only

Variable-only families (Noto Sans, Montserrat, Oswald) are pinned to static
Regular/Bold instances so libass and the browser load the same bytes.

manifest.json: {id: {family, assScale, files: {"<weight><i?>": file}}}.
assScale = unitsPerEm / (OS/2 usWinAscent + usWinDescent): libass (like
VSFilter/GDI) sizes a font so winAscent+winDescent = Fontsize, CSS sizes the
em, so css font-size = ASS size * assScale. (Plan 011 said hhea; rendering an
"H" at \fs100 through libass matched win metrics for every font to ~1%, hhea
was off by 10-65%.) Falls back to hhea when the win metrics are zero. Keep ids/families in sync with FONTS in
src/style.js.
"""
import json, shutil, sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

FONTS = Path(__file__).resolve().parent.parent / "fonts"
# libass fontsdir: must hold nothing but font files (it tries to load every file).
TTF = FONTS / "ttf"
LICENSES = FONTS / "licenses"
# id -> (family, {face key: (source file, pinned axes or None)})
SOURCES = {
    "noto-sans": ("Noto Sans", {
        "400": ("NotoSans[wdth,wght].ttf", {"wght": 400, "wdth": 100}),
        "700": ("NotoSans[wdth,wght].ttf", {"wght": 700, "wdth": 100}),
        "400i": ("NotoSans-Italic[wdth,wght].ttf", {"wght": 400, "wdth": 100}),
        "700i": ("NotoSans-Italic[wdth,wght].ttf", {"wght": 700, "wdth": 100}),
    }),
    "montserrat": ("Montserrat", {
        "400": ("Montserrat[wght].ttf", {"wght": 400}),
        "700": ("Montserrat[wght].ttf", {"wght": 700}),
        "400i": ("Montserrat-Italic[wght].ttf", {"wght": 400}),
        "700i": ("Montserrat-Italic[wght].ttf", {"wght": 700}),
    }),
    "poppins": ("Poppins", {
        "400": ("Poppins-Regular.ttf", None),
        "700": ("Poppins-Bold.ttf", None),
        "400i": ("Poppins-Italic.ttf", None),
        "700i": ("Poppins-BoldItalic.ttf", None),
    }),
    "oswald": ("Oswald", {
        "400": ("Oswald[wght].ttf", {"wght": 400}),
        "700": ("Oswald[wght].ttf", {"wght": 700}),
    }),
    "anton": ("Anton", {"400": ("Anton-Regular.ttf", None)}),
    "bebas-neue": ("Bebas Neue", {"400": ("BebasNeue-Regular.ttf", None)}),
    "bangers": ("Bangers", {"400": ("Bangers-Regular.ttf", None)}),
    "permanent-marker": ("Permanent Marker", {"400": ("PermanentMarker-Regular.ttf", None)}),
}
STYLE = {"400": "Regular", "700": "Bold", "400i": "Italic", "700i": "BoldItalic"}


def out_name(family, key):
    return f"{family.replace(' ', '')}-{STYLE[key]}.ttf"


def build(src):
    for family, faces in (v for v in SOURCES.values()):
        for key, (file, axes) in faces.items():
            dest = TTF / out_name(family, key)
            if axes is None:
                shutil.copyfile(src / file, dest)
                continue
            font = instancer.instantiateVariableFont(
                TTFont(src / file), axes, updateFontNames=True)
            font.save(dest)
    for lic in src.glob("*-OFL.txt"):
        shutil.copyfile(lic, LICENSES / lic.name)
    for lic in src.glob("*-LICENSE.txt"):
        shutil.copyfile(lic, LICENSES / lic.name)


def manifest():
    out = {}
    for fid, (family, faces) in SOURCES.items():
        files = {k: out_name(family, k) for k in faces}
        f = TTFont(TTF / files["400"])
        name = f["name"].getBestFamilyName()
        if name != family:
            sys.exit(f"{files['400']}: family is {name!r}, expected {family!r}")
        os2, hhea = f["OS/2"], f["hhea"]
        height = (os2.usWinAscent + os2.usWinDescent) or (hhea.ascent - hhea.descent)
        scale = f["head"].unitsPerEm / height
        out[fid] = {"family": family, "assScale": round(scale, 4), "files": files}
    (FONTS / "manifest.json").write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    TTF.mkdir(parents=True, exist_ok=True)
    LICENSES.mkdir(exist_ok=True)
    if "--from" in sys.argv:
        build(Path(sys.argv[sys.argv.index("--from") + 1]))
    manifest()
