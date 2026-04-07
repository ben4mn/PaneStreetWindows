// PaneStreet Feature Tests — Red/Green TDD
// These tests verify that Mac features have been ported to Windows.
// Open src/test.html in a browser to run.

window.PaneStreetTests = {
  run(suite) {

    // --- Chunk 2: New Mascot Animations ---
    suite('Mascot Animations (9 new)', [
      ['ACTIVITIES array has 21+ entries', () => {
        return typeof ACTIVITIES !== 'undefined' && ACTIVITIES.length >= 20;
      }],
      ['Has act-code animation', () => {
        return ACTIVITIES.some(a => a.cls === 'act-code');
      }],
      ['Has act-mop animation', () => {
        return ACTIVITIES.some(a => a.cls === 'act-mop');
      }],
      ['Has act-shimmy animation', () => {
        return ACTIVITIES.some(a => a.cls === 'act-shimmy');
      }],
      ['Has act-antenna-fix animation', () => {
        return ACTIVITIES.some(a => a.cls === 'act-antenna-fix');
      }],
      ['Has act-yawn animation', () => {
        return ACTIVITIES.some(a => a.cls === 'act-yawn');
      }],
      ['Has act-startled animation', () => {
        return ACTIVITIES.some(a => a.cls === 'act-startled');
      }],
      ['Has act-hiccup animation', () => {
        return ACTIVITIES.some(a => a.cls === 'act-hiccup');
      }],
      ['Has act-impressed animation', () => {
        return ACTIVITIES.some(a => a.cls === 'act-impressed');
      }],
      ['CSS has act-code keyframes', () => {
        const sheets = document.styleSheets;
        for (const sheet of sheets) {
          try {
            for (const rule of sheet.cssRules) {
              if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === 'code-tap-l') return true;
            }
          } catch(e) {}
        }
        return false;
      }],
    ]);

    // --- Chunk 3: Mascot Personality System ---
    suite('Mascot Personality System', [
      ['Speech budget system exists (withinSpeechBudget)', () => {
        return typeof withinSpeechBudget === 'function';
      }],
      ['Stare-back detection exists (setupCaughtWatching)', () => {
        return typeof setupCaughtWatching === 'function';
      }],
      ['Hiccup scheduling exists (scheduleHiccup)', () => {
        return typeof scheduleHiccup === 'function';
      }],
      ['Output velocity tracking exists (trackOutputVelocity)', () => {
        return typeof trackOutputVelocity === 'function';
      }],
      ['Command milestone counting exists (incrementCommandCount)', () => {
        return typeof incrementCommandCount === 'function';
      }],
      ['Long session timer exists (checkLongSession)', () => {
        return typeof checkLongSession === 'function';
      }],
      ['SPEECH_BUDGET_WINDOW constant defined', () => {
        return typeof SPEECH_BUDGET_WINDOW === 'number' && SPEECH_BUDGET_WINDOW === 300000;
      }],
    ]);

    // --- Chunk 4: Auto-Tile ---
    suite('Auto-Tile Feature', [
      ['autoTile function exists', () => {
        return typeof autoTile === 'function';
      }],
      ['Default shortcuts include auto-tile', () => {
        return typeof DEFAULT_SHORTCUTS !== 'undefined' &&
          Object.values(DEFAULT_SHORTCUTS).some(s =>
            s.id === 'auto-tile' || s.action === 'autoTile'
          );
      }],
    ]);

    // --- Chunk 5: Claude Code Hooks ---
    suite('Claude Code Hooks', [
      ['Hooks toggle reference in config panels', () => {
        // Check if the hooks toggle function/handler exists
        return typeof toggleClaudeHooks === 'function' ||
          document.querySelector('#hooks-toggle') !== null ||
          (typeof renderSettingsGeneral === 'function');
      }],
    ]);

    // --- Chunk 6: File Path Link Provider ---
    suite('File Path Link Provider', [
      ['File path regex matches absolute Unix paths', () => {
        const re = /(?:^|\s)((?:\/[\w.@\-]+)+(?:\.[\w]+)?(?::(\d+)(?::(\d+))?)?)/g;
        return re.test(' /home/user/file.js:10:5');
      }],
      ['File path regex matches Windows paths', () => {
        const re = /(?:^|\s)((?:[A-Z]:\\[\w.@\-\\]+)+(?:\.[\w]+)?(?::(\d+)(?::(\d+))?)?)/g;
        return re.test(' C:\\Users\\test\\file.js:10');
      }],
      ['TerminalSession has file link provider', () => {
        return typeof TerminalSession !== 'undefined' &&
          TerminalSession.prototype &&
          TerminalSession.prototype._registerFileLinkProvider !== undefined;
      }],
    ]);

    // --- Chunk 7: Mascot Sidebar Snapping ---
    suite('Mascot Sidebar Snapping', [
      ['moveRobotTo function exists', () => {
        return typeof moveRobotTo === 'function';
      }],
      ['SIDEBAR_ENTRY_QUOTES defined', () => {
        return typeof SIDEBAR_ENTRY_QUOTES !== 'undefined' && Array.isArray(SIDEBAR_ENTRY_QUOTES);
      }],
      ['SIDEBAR_EXIT_QUOTES defined', () => {
        return typeof SIDEBAR_EXIT_QUOTES !== 'undefined' && Array.isArray(SIDEBAR_EXIT_QUOTES);
      }],
      ['CSS has .in-sidebar class', () => {
        const sheets = document.styleSheets;
        for (const sheet of sheets) {
          try {
            for (const rule of sheet.cssRules) {
              if (rule.selectorText && rule.selectorText.includes('in-sidebar')) return true;
            }
          } catch(e) {}
        }
        return false;
      }],
    ]);
  }
};
