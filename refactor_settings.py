import re

path = '/home/adityatawde9699/projects/Cognate/src/components/Modals/SettingsModal.tsx'
with open(path, 'r') as f:
    content = f.read()

# 1. Update the overall layout
content = content.replace(
    '<div className="panel-body">',
    '''<div className="settings-layout">
        <div className="settings-sidebar">
          <button className={`tag-nav-btn ${activeTab === 'general' ? 'active' : ''}`} onClick={() => setActiveTab('general')}><i className="fa-solid fa-sliders tn-hash"></i> General</button>
          <button className={`tag-nav-btn ${activeTab === 'ai' ? 'active' : ''}`} onClick={() => setActiveTab('ai')}><i className="fa-solid fa-sparkles tn-hash"></i> AI Assistant</button>
          <button className={`tag-nav-btn ${activeTab === 'calendar' ? 'active' : ''}`} onClick={() => setActiveTab('calendar')}><i className="fa-regular fa-calendar tn-hash"></i> Calendar</button>
          <button className={`tag-nav-btn ${activeTab === 'integrations' ? 'active' : ''}`} onClick={() => setActiveTab('integrations')}><i className="fa-solid fa-plug tn-hash"></i> Integrations</button>
          <button className={`tag-nav-btn ${activeTab === 'sync' ? 'active' : ''}`} onClick={() => setActiveTab('sync')}><i className="fa-solid fa-cloud-arrow-up tn-hash"></i> Sync & Team</button>
        </div>
        <div className="settings-content panel-body">'''
)

content = content.replace('      </div>\n    </div>\n  );\n}', '        </div>\n      </div>\n    </div>\n  );\n}')

# Remove the old nav
old_nav_pattern = r'<div className="settings-nav".*?</div>'
content = re.sub(old_nav_pattern, '', content, flags=re.DOTALL)

# Let's wrap each component based on its tab.
# We will use regex to find each section and wrap it in `{activeTab === 'TAB_NAME' && (<>\n ... \n</>)}`
# To avoid multiple <>, we can just group consecutive ones later, but individual is fine too, or we can just do one big replace since we can script it.

def extract_block(pattern):
    match = re.search(pattern, content, re.DOTALL)
    if not match: return ""
    return match.group(0)

b_lang = extract_block(r'<LanguageSelect />')
b_hero = extract_block(r'<div className="settings-hero">.*?</div>\n          </div>\n        </div>') # careful with nested divs
# A better way to get b_hero:
hero_start = content.find('<div className="settings-hero">')
# Count divs
div_count = 0
hero_end = hero_start
i = hero_start
while i < len(content):
    if content[i:i+4] == '<div':
        div_count += 1
    elif content[i:i+6] == '</div>':
        div_count -= 1
        if div_count == 0:
            hero_end = i + 6
            break
    i += 1
b_hero = content[hero_start:hero_end]

def get_tag(tag_name):
    # e.g., <SettingsSection id="timer"> ... </SettingsSection>
    start = content.find(f'<SettingsSection id="{tag_name}"')
    if start == -1: return ""
    end_tag = '</SettingsSection>'
    end = content.find(end_tag, start) + len(end_tag)
    return content[start:end]

b_timer = get_tag('timer')
b_ai = get_tag('ai')
b_notif = get_tag('notifications')
b_cf = get_tag('customFields')
b_int = get_tag('integrations')
b_house = get_tag('housekeeping')
b_device = get_tag('deviceSync')
b_sync = get_tag('sync')
b_cal = get_tag('calendar')

b_backup = extract_block(r'<BackupsSection />')
b_updates = extract_block(r'<UpdatesSection />')
b_live = extract_block(r'<LiveSyncSettings />')
b_shared = extract_block(r'<SharedProjects />')

# Now build the new content area
new_content_area = f"""
          {{activeTab === 'general' && (
            <>
              {b_lang}
              {b_hero}
              {b_timer}
              {b_notif}
              {b_house}
              {b_updates}
            </>
          )}}

          {{activeTab === 'ai' && (
            <>
              {b_ai}
            </>
          )}}

          {{activeTab === 'calendar' && (
            <>
              {b_cal}
            </>
          )}}

          {{activeTab === 'integrations' && (
            <>
              {b_cf}
              {b_int}
            </>
          )}}

          {{activeTab === 'sync' && (
            <>
              {b_live}
              {b_shared}
              {b_device}
              {b_sync}
              {b_backup}
            </>
          )}}
"""

# Replace everything inside <div className="settings-content panel-body"> and the end of file
start_content = content.find('<div className="settings-content panel-body">') + len('<div className="settings-content panel-body">')
end_content = content.rfind('        </div>\n      </div>\n    </div>\n  );\n}')

final_content = content[:start_content] + new_content_area + content[end_content:]

with open(path, 'w') as f:
    f.write(final_content)

print("Refactored SettingsModal.tsx successfully.")
