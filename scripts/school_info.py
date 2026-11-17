"""Validate and render the independently reviewed school information snapshot."""
import html
import json
import re
from datetime import date
from pathlib import Path
from urllib.parse import urlencode, urlparse


def require(condition, message):
    if not condition:
        raise ValueError('學校基本資料：' + message)


def text(value, label):
    require(isinstance(value, str) and bool(value.strip()) and len(value) <= 2000, label + '缺少文字')
    return value


def https(value):
    parsed = urlparse(text(value, '來源網址'))
    require(parsed.scheme == 'https' and bool(parsed.hostname) and not parsed.username and not parsed.password, '來源須為 HTTPS 網址')
    return value


def load_info(root, config):
    path = Path(root) / 'school-info.json'
    require(path.is_file(), '缺少 school-info.json')
    require(not path.is_symlink(), '不得使用符號連結')
    data = json.loads(path.read_text(encoding='utf-8'))
    require(data['schemaVersion'] == 1, '不支援的版本')
    date.fromisoformat(data['checkedOn'])
    require(bool(re.fullmatch(r'\d{3}', data['directoryYear'])), '學年度格式錯誤')
    for source in data['sources'].values():
        https(source['url'])
        https(source['downloadURL'])
        require(bool(re.fullmatch(r'[a-f0-9]{64}', source['sha256'])), '來源雜湊格式錯誤')
    known = {meta['slug']: (name, meta) for name, meta in config['schoolMeta'].items()}
    require(set(data['schools']) <= set(known), '出現未設定學校')
    ids = set()
    for slug, item in data['schools'].items():
        name, meta = known[slug]
        require(bool(re.fullmatch(r'\d{6}', item['schoolId'])) and item['schoolId'] not in ids, '學校代碼錯誤或重複')
        ids.add(item['schoolId'])
        require(item['name'].endswith(name.replace('國小', '國民小學')), '校名不符')
        text(item['address'], '地址')
        require(bool(re.fullmatch(r'02-\d{8}', item['phone'])), '電話格式錯誤')
        require(https(item['website']).rstrip('/') == meta['site'].rstrip('/'), '官網與設定不符')
        https(item['basicSource']['url'])
        https(item['contactSource'])
        directory, campus = item['sourceRecords']['directory'], item['sourceRecords']['campus']
        require(directory['代碼'] == item['schoolId'] and directory['學年度'] == data['directoryYear'], '名錄代碼或學年度不符')
        require(campus['校名'] == item['name'], '校園開放資料校名不符')
        opening = item['opening']
        require(opening['basis'] in ('校方公告', '市府登錄'), '缺少時段依據')
        text(opening['note'], '開放說明')
        require(isinstance(opening['rows'], list) and len(opening['rows']) <= 12, '時段清單錯誤')
        for row in opening['rows']:
            text(row['label'], '時段名稱')
            text(row['hours'], '時段')
        require(bool(opening['sources']), '缺少開放時間來源')
        for source in opening['sources']:
            text(source['label'], '來源名稱')
            https(source['url'])
    return data


def render_info(data, slug):
    if not data or slug not in data['schools']:
        return ''
    item = data['schools'][slug]
    esc = lambda value: html.escape(str(value), quote=True)
    def link(url, label, class_name=''):
        attributes = f' class="{esc(class_name)}"' if class_name else ''
        return f'<a{attributes} href="{esc(url)}" target="_blank" rel="noopener">{esc(label)}<span class="sr-only">（另開分頁）</span></a>'
    opening = item['opening']
    navigation = 'https://www.google.com/maps/search/?' + urlencode({'api': '1', 'query': item['name'] + ' ' + item['address']})
    hours = '<dl class="school-hours">' + ''.join(f'<div><dt>{esc(row["label"])}</dt><dd>{esc(row["hours"])}</dd></div>' for row in opening['rows']) + '</dl>' if opening['rows'] else ''
    return f'''<section class="school-info-section" aria-labelledby="schoolContactTitle">
      <h3 id="schoolContactTitle">聯絡資訊</h3>
      <dl class="school-contact">
        <div><dt>地址</dt><dd class="school-address"><span class="school-contact-value">{esc(item['address'])}</span>{link(navigation, '地圖導航', 'school-contact-action')}</dd></div>
        <div><dt>電話</dt><dd><a href="tel:{item['phone'].replace('-', '')}">{esc(item['phone'])}</a></dd></div>
        <div><dt>官網</dt><dd>{link(item['website'], '學校官方網站')}</dd></div>
      </dl>
    </section>
    <section class="school-info-section" aria-labelledby="schoolHoursTitle">
      <div class="school-info-section-heading"><h3 id="schoolHoursTitle">校園場地開放時間</h3><span>{esc(opening['basis'])}</span></div>
      {hours}<p class="school-opening-note">{esc(opening['note'])}</p>
      <p class="school-info-source">此處為一般開放資訊，並非即時開放狀態。國定假日、寒暑假或特殊活動未列明的時段，請洽學校確認。</p>
      <div id="schoolOpeningNotices" class="school-opening-notices" hidden></div>
    </section>
    <details class="school-info-provenance">
      <summary>資料來源・查核 <time datetime="{esc(data['checkedOn'])}">{esc(data['checkedOn'].replace('-', '/'))}</time></summary>
      <p class="school-info-source">基本資料：{link(item['basicSource']['url'], item['basicSource']['label'])}，並核對{link(item['contactSource'], '學校官網')}。</p>
      <p class="school-info-source">開放資訊：{'、'.join(link(source['url'], source['label']) for source in opening['sources'])}</p>
      <p class="school-info-source">查核日期與頁面公告的「最近檢查」分開計算。</p>
    </details>'''
