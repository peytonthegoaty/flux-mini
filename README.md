# Flux Mini

A small copy of Flux: games, a web proxy and wallpapers, all from one SVG page.

- `extra.svg?f3` opens the site.
- `extra.svg` on its own just shows a picture.
- `index.html` is a calculator.

## Put it online

You need [git](https://git-scm.com), Python and the [GitHub CLI](https://cli.github.com).

```bash
gh auth login
python upload.py
```

It makes a public repo called `flux-mini`, turns on GitHub Pages and prints your link. For a different name, run `python upload.py my-repo-name`. Run it again after any change.

## Try it on your computer

```bash
python -m http.server 8000
```

Then open `http://localhost:8000/extra.svg?f3`.

## Change things

- **The page:** edit `src/page.html`, then run `python build_svg.py`.
- **Games:** add a folder to `edutools/` and a line to `edulist.txt`, with its cover in `visuals/`.
- **The picture:** replace `src/decoy.svg`.
