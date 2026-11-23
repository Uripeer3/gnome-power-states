UUID := power-states@uripeer3.github.io
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA_DIR := schemas
PACK_OUT := $(UUID).shell-extension.zip

.PHONY: all compile-schemas test check-syntax install uninstall enable disable prefs pack clean

all: compile-schemas test

compile-schemas:
	glib-compile-schemas --strict $(SCHEMA_DIR)

test: compile-schemas check-syntax
	gjs -m tests/policyEngine.test.js
	gjs -m tests/lidController.test.js
	gjs -m tests/idleController.test.js

check-syntax:
	@for f in lib/*.js; do \
		out="$$(gjs -m "$$f" 2>&1)" || { echo "LOAD/SYNTAX ERROR in $$f:"; printf '%s\n' "$$out"; exit 1; }; \
	done
	@set -e; for f in extension.js prefs.js; do \
		out="$$(gjs -m "$$f" 2>&1 || true)"; \
		if printf '%s\n' "$$out" | grep -qi "SyntaxError"; then \
			echo "SYNTAX ERROR in $$f:"; printf '%s\n' "$$out"; exit 1; \
		fi; \
		python3 -c 'import pathlib, re, sys; src = pathlib.Path(sys.argv[1]); text = src.read_text(); tok_re = re.compile(r"//[^\n]*|/\*[\s\S]*?\*/|(\"(?:\\.|[^\"\\\n])*\"|\x27(?:\\.|[^\x27\\\n])*\x27|`(?:\\.|[^`\\])*`)|([A-Za-z_$$][A-Za-z0-9_$$]*|\(|\S)"); prev2 = prev1 = ""; missing = []; [((prev1 in ("from", "import") or (prev2 == "import" and prev1 == "(")) and m.group(1)[0] != "`" and re.match(r"^\.\.?/", m.group(1)[1:-1]) and not (src.parent / m.group(1)[1:-1]).resolve().is_file() and missing.append(m.group(1)[1:-1])) if m.group(1) else None for m in tok_re.finditer(text) if (m.group(1) or m.group(2)) and (not m.group(2) or ((prev2 := prev1), (prev1 := m.group(2)), True)[-1])]; sys.exit("MISSING LOCAL IMPORT in " + sys.argv[1] + ": " + ", ".join(missing)) if missing else None' "$$f" || exit 1; \
	done
	@echo "Libraries loaded; entry-point syntax and single/multiline relative imports verified"
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
