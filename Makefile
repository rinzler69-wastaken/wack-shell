# GNOME Shell extension quick installer

SHELL := /bin/sh
UUID  := wack-shell@rinzler69-wastaken.github.com
DEST  := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
EXCLUDES := --exclude '.git' --exclude '.gitignore' --exclude '.codex' --exclude '.sixth' --exclude 'Makefile' --exclude '*.zip'

.PHONY: install enable pack compile-po

compile-po: ## Compile all .po files to .mo binaries in locale/
	@if [ -d "po" ] && [ -f "po/generate.py" ]; then python3 po/generate.py; fi

install: compile-po ## Copy the extension into the correct UUID directory
	@mkdir -p "$(DEST)"
	@rsync -a --delete $(EXCLUDES) ./ "$(DEST)/"
	@if [ -d "$(DEST)/schemas" ]; then glib-compile-schemas "$(DEST)/schemas"; fi
	@printf 'Installed to %s\n' "$(DEST)"
	@printf 'Reload GNOME Shell (Alt+F2 → r on Xorg, relogin on Wayland) then run: gnome-extensions enable %s\n' "$(UUID)"

enable: install ## Install then enable the extension
	@gnome-extensions enable "$(UUID)"

pack: compile-po ## Create a ZIP package for Extensions.gnome.org
	@printf 'Packaging extension...\n'
	@rm -f $(UUID).zip
	@glib-compile-schemas schemas
	@zip -qr $(UUID).zip *.js metadata.json *.css Resources schemas `if [ -d locale ]; then echo locale; fi` `if [ -f LICENSE ]; then echo LICENSE; fi` -x "schemas/gschemas.compiled"
	@printf 'Created package: %s\n' "$(UUID).zip"
