# Fork-local entry points (split panes + project-grouped sidebar).
# Every build/dev/check action for this fork goes through these targets.

NODE_BIN := $(HOME)/.nvm/versions/node/v24.22.0/bin
export PATH := $(NODE_BIN):$(PATH)
export COREPACK_ENABLE_DOWNLOAD_PROMPT := 0
PNPM := corepack pnpm@11.10.0

# Separate data home so the fork never touches the official ~/.t3 state.
FORK_HOME ?= $(HOME)/.t3-fork

.PHONY: install seed-dev-db dev dev-desktop typecheck typecheck-web lint-web test-fork build-desktop build-desktop-signed install-app install-latest

install:
	$(PNPM) install

# Copies a read-only slice of the live ~/.t3 database into the fork's home so
# the dev app shows real projects and threads. The live database is only read.
seed-dev-db:
	$(PNPM) migrate-dev-db --base-dir $(FORK_HOME)

# Web + server dev loop against the fork's own data home.
dev:
	$(PNPM) dev --home-dir $(FORK_HOME)

dev-desktop:
	$(PNPM) dev:desktop --home-dir $(FORK_HOME)

typecheck:
	$(PNPM) typecheck

# Fork checks: web + contracts typecheck, lint of the files this fork changes,
# and the unit tests next to them.
FORK_TESTS := apps/web/src/fork/chatPanes.logic.test.ts apps/web/src/fork/sidebarProjectGroups.logic.test.ts apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/Sidebar.drag.test.ts apps/web/src/components/threadActionMenu.logic.test.ts packages/contracts/src/settings.test.ts

typecheck-web:
	$(PNPM) exec vp run --filter @t3tools/web typecheck
	$(PNPM) exec vp run --filter @t3tools/contracts typecheck

# Every TS file the fork changes relative to upstream (committed or not).
FORK_CHANGED_TS = $$( { git diff --name-only --diff-filter=ACMR $$(git merge-base HEAD upstream/main); git ls-files --others --exclude-standard; } | grep -E '\.(ts|tsx)$$' | sort -u)

lint-web:
	$(PNPM) exec vp lint $(FORK_CHANGED_TS)

test-fork:
	$(PNPM) exec vp test run $(FORK_TESTS)

# The resource monitor needs rustc 1.95; reuse the binary shipped in the
# installed official app instead of upgrading the system toolchain.
RESOURCE_MONITOR_SRC ?= /Applications/T3 Code (Nightly).app/Contents/Resources/resource-monitor/t3-resource-monitor
RESOURCE_MONITOR_DST := native/resource-monitor/target/aarch64-apple-darwin/release/t3-resource-monitor

$(RESOURCE_MONITOR_DST):
	mkdir -p $(dir $(RESOURCE_MONITOR_DST))
	cp "$(RESOURCE_MONITOR_SRC)" $(RESOURCE_MONITOR_DST)

# A nightly-shaped version keeps the runtime identity of the official Nightly
# (app name, keychain entry, profile), so the fork reads the same settings.
# No update repository is set, so the build ships without an update feed and
# never replaces itself with an official release.
FORK_BUILD_VERSION ?= 0.0.46-nightly.$(shell date +%Y%m%d).9$(shell date +%H%M)

# Unsigned macOS arm64 DMG.
build-desktop: $(RESOURCE_MONITOR_DST)
	env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true \
		$(PNPM) dist:desktop:dmg:arm64 --build-version $(FORK_BUILD_VERSION)

# Developer ID signed + notarized build with an update feed pointing at the
# fork's GitHub releases (the same build CI publishes). Uses the Developer ID
# identity from the login keychain and the App Store Connect API key in
# ~/.signing/t3code-fork for notarization.
SIGNING_DIR ?= $(HOME)/.signing/t3code-fork
FORK_UPDATE_REPOSITORY ?= onuraycicek/t3code-fork

build-desktop-signed: $(RESOURCE_MONITOR_DST)
	T3CODE_DESKTOP_SKIP_MAC_PASSKEYS=true \
	T3CODE_DESKTOP_UPDATE_REPOSITORY=$(FORK_UPDATE_REPOSITORY) \
	T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true \
	APPLE_API_KEY=$(SIGNING_DIR)/AuthKey_27GTRK76V8.p8 APPLE_API_KEY_ID=27GTRK76V8 \
	APPLE_API_ISSUER=85c77e95-1c00-49b2-bdee-dc1678d5151e \
		$(PNPM) dist:desktop:dmg:arm64 --build-version $(FORK_BUILD_VERSION) --signed

# Unpacks the newest build as /Applications/T3 Code Fork.app and signs the whole
# bundle with the local Apple Development certificate. A stable certificate
# keeps the app's designated requirement the same across builds, so a keychain
# "Always Allow" survives updates (ad-hoc signatures change with every build).
# Quit the app before running this.
FORK_APP := /Applications/T3 Code Fork.app
FORK_SIGN_IDENTITY ?= Apple Development

install-app:
	rm -rf release/app && mkdir -p release/app
	ditto -x -k "$$(ls -t release/*-arm64.zip | head -1)" release/app
	/bin/rm -rf "$(FORK_APP)"
	ditto "release/app/T3 Code (Nightly).app" "$(FORK_APP)"
	# Developer ID builds (CI and build-desktop-signed) keep their notarized
	# signature; only unsigned local builds get the Apple Development identity.
	codesign -dvv "$(FORK_APP)" 2>&1 | grep -q "Authority=Developer ID Application" || \
		codesign --force --deep --sign "$(FORK_SIGN_IDENTITY)" "$(FORK_APP)"
	codesign --verify --deep --strict "$(FORK_APP)"

# Downloads the newest CI prerelease (Developer ID signed + notarized, update
# feed = this repo), quits the running fork app, replaces it and relaunches.
# Run from Terminal, not from inside the app. After this, updates arrive by
# themselves through the app's built-in updater.
install-latest:
	/bin/rm -rf "$(TMPDIR)t3fork-latest" && mkdir -p "$(TMPDIR)t3fork-latest"
	gh release download --repo $(FORK_UPDATE_REPOSITORY) --pattern '*-arm64.zip' --dir "$(TMPDIR)t3fork-latest" \
		"$$(gh release list --repo $(FORK_UPDATE_REPOSITORY) --limit 1 --json tagName --jq '.[0].tagName')"
	ditto -x -k "$(TMPDIR)t3fork-latest/"*-arm64.zip "$(TMPDIR)t3fork-latest/app"
	codesign -dvv "$(TMPDIR)t3fork-latest/app/T3 Code (Nightly).app" 2>&1 | grep -q "Authority=Developer ID Application"
	-osascript -e 'tell application "$(FORK_APP)" to quit'
	@for i in $$(seq 1 30); do pgrep -f "$(FORK_APP)/Contents/MacOS" >/dev/null || break; sleep 1; done
	/bin/rm -rf "$(FORK_APP)"
	ditto "$(TMPDIR)t3fork-latest/app/T3 Code (Nightly).app" "$(FORK_APP)"
	codesign --verify --deep --strict "$(FORK_APP)"
	open "$(FORK_APP)"
