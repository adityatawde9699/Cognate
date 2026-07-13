import re

with open('src/style.css', 'r') as f:
    css = f.read()

# 1. Update Shadows in :root (dark mode)
css = css.replace(
    '    --shadow-sm: 0 1px 2px rgba(0, 0, 0, .30);',
    '    --shadow-sm: 0 4px 12px -2px rgba(0, 0, 0, .25);'
)
css = css.replace(
    '    --shadow-md: 0 8px 24px rgba(0, 0, 0, .32);',
    '    --shadow-md: 0 12px 32px -4px rgba(0, 0, 0, .35);'
)
css = css.replace(
    '    --shadow-lg: 0 20px 56px rgba(0, 0, 0, .50);',
    '    --shadow-lg: 0 24px 64px -8px rgba(0, 0, 0, .45);'
)

# 2. Update global transition
css = css.replace(
    '    --trans:     .18s cubic-bezier(.4, 0, .2, 1);',
    '    --trans:     .28s cubic-bezier(0.16, 1, 0.3, 1);'
)

# 3. Update Shadows in Light Mode
css = css.replace(
    '    --shadow-sm: 0 1px 2px rgba(40, 40, 40, .06);',
    '    --shadow-sm: 0 4px 12px -2px rgba(40, 40, 40, .06);'
)
css = css.replace(
    '    --shadow-md: 0 8px 24px rgba(40, 40, 40, .09);',
    '    --shadow-md: 0 12px 32px -4px rgba(40, 40, 40, .09);'
)
css = css.replace(
    '    --shadow-lg: 0 20px 56px rgba(40, 40, 40, .14);',
    '    --shadow-lg: 0 24px 64px -8px rgba(40, 40, 40, .14);'
)

# 4. Enhance Body Background Glows
css = css.replace(
    'rgba(52,211,153,.07)', 'rgba(52,211,153,.12)'
)
css = css.replace(
    'rgba(52,211,153,.04)', 'rgba(52,211,153,.08)'
)

# 5. Liquid Glass (inner refraction border) for specific classes
# We add `box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);` to `--glass` and `--surface` elements.
# Wait, let's just add it to `.task-card` and `.tile` directly.

# Task card
css = css.replace(
    'backdrop-filter: blur(var(--glass-blur)); box-shadow: var(--shadow-sm);',
    'backdrop-filter: blur(var(--glass-blur)); box-shadow: var(--shadow-sm), inset 0 1px 0 rgba(255, 255, 255, 0.06);'
)

css = css.replace(
    '.task-card:hover {\n    transform: translateY(-2px); border-color: var(--border-strong);\n    box-shadow: var(--shadow-md); background: var(--glass-h);\n}',
    '.task-card:hover {\n    transform: translateY(-2px); border-color: var(--border-strong);\n    box-shadow: var(--shadow-md), inset 0 1px 0 rgba(255, 255, 255, 0.08); background: var(--glass-h);\n}'
)

# Tile (Bento grids)
css = css.replace(
    'backdrop-filter: blur(var(--glass-blur)); box-shadow: var(--shadow-sm);\n    padding: 20px;',
    'backdrop-filter: blur(var(--glass-blur)); box-shadow: var(--shadow-sm), inset 0 1px 0 rgba(255, 255, 255, 0.06);\n    padding: 24px;'
)

# 6. Tactile scale on :active
css = css.replace(
    '.task-card:active { cursor: grabbing; transform: translateY(0) scale(.99); }',
    '.task-card:active { cursor: grabbing; transform: translateY(0) scale(.98); }'
)

# Add .btn-primary:active
css = css.replace(
    '.btn-primary:hover { filter: brightness(1.06); transform: translateY(-1px); }',
    '.btn-primary:hover { filter: brightness(1.06); transform: translateY(-1px); }\n.btn-primary:active { transform: scale(0.98); }'
)

# Add .btn-add:active
css = css.replace(
    '.btn-add:hover { filter: brightness(1.06); transform: translateY(-1px); }',
    '.btn-add:hover { filter: brightness(1.06); transform: translateY(-1px); }\n.btn-add:active { transform: scale(0.98); }'
)

# 7. Refine Stat Card (bento grid non-glass)
css = css.replace(
    'padding: 18px; border-radius: var(--radius-l);',
    'padding: 22px; border-radius: var(--radius-l);'
)

with open('src/style.css', 'w') as f:
    f.write(css)

print("Applied CSS aesthetic upgrades.")
