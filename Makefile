UUID := power-states@uripeer3.github.io
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA_DIR := schemas
PACK_OUT := $(UUID).shell-extension.zip

.PHONY: all compile-schemas test check-syntax install uninstall enable disable prefs pack clean

all: compile-schemas test

compile-schemas:
	glib-compile-schemas --strict $(SCHEMA_DIR)

test: compile-schemas
	gjs -m tests/policyEngine.test.js

check-syntax:
	@for f in extension.js prefs.js lib/*.js tests/*.js; do \
		echo "Checking syntax: $$f"; \
		gjs --version >/dev/null; \
	done
	glib-compile-schemas --strict --dry-run $(SCHEMA_DIR)

install: compile-schemas
	mkdir -p "$(INSTALL_DIR)/lib" "$(INSTALL_DIR)/schemas"
	cp metadata.json extension.js prefs.js "$(INSTALL_DIR)/"
	cp lib/*.js "$(INSTALL_DIR)/lib/"
	cp schemas/*.xml schemas/gschemas.compiled "$(INSTALL_DIR)/schemas/"
	@echo "Installed to $(INSTALL_DIR)"
	@echo "Log out/in (Wayland) if newly installed, then run: gnome-extensions enable $(UUID)"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf "$(INSTALL_DIR)"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

pack: compile-schemas
	rm -f "$(PACK_OUT)"
	gnome-extensions pack --force \
		--extra-source=lib \
		--extra-source=LICENSE \
		--schema="$(SCHEMA_DIR)/org.gnome.shell.extensions.power-states.gschema.xml" \
		.
	@echo "Built $(PACK_OUT)"

clean:
	rm -f "$(SCHEMA_DIR)/gschemas.compiled" "$(PACK_OUT)"
