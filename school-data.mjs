import {mergeArticles, safeURL} from './news-core.mjs';

export const SCHOOL_SCHEMA = 1;

export function schoolName(config, slug) {
  if (!/^[a-z][a-z0-9-]*$/.test(slug || '')) throw new Error('學校識別碼無效');
  const name = config.schools.find(name => config.schoolMeta?.[name]?.slug === slug);
  if (!name) throw new Error('未知學校');
  return name;
}

export function packSchoolData(config, merged, slug) {
  const school = schoolName(config, slug);
  const articles = merged.filter(article => article.schools.includes(school)).map(article => {
    const origins = article.origins.map(origin => ({
      id: origin.id, sourceId: origin.sourceId, url: origin.url || '', attachments: origin.attachments || [],
    }));
    return {
      id: article.id, title: article.title, published: article.published, url: article.url || '',
      summary: article.summary || '', attachments: article.attachments || [],
      sourceIds: [...new Set(origins.map(origin => origin.sourceId))], origins,
    };
  });
  return {kind: 'school-news', schemaVersion: SCHOOL_SCHEMA, school, articles};
}

export function prepareSchoolData(config, raw, slug) {
  return packSchoolData(config, mergeArticles(raw), slug);
}

export function validateSchoolData(config, data, slug) {
  const school = schoolName(config, slug);
  if (data?.kind !== 'school-news' || data.schemaVersion !== SCHOOL_SCHEMA || data.school !== school
    || !Array.isArray(data.articles)) throw new Error('學校資料格式不相容');
  const sources = new Map(config.sources.map(source => [source.id, source]));
  const seen = new Set();
  const validAttachments = items => Array.isArray(items) && items.every(item => (
    typeof item === 'string' ? item.trim() : item && typeof item.name === 'string' && item.name.trim() && safeURL(item.url)
  ));
  for (const article of data.articles) {
    if (!article || typeof article.id !== 'string' || !article.id || seen.has(article.id)
      || typeof article.title !== 'string' || !article.title.trim()
      || typeof article.summary !== 'string' || !Number.isFinite(Date.parse(article.published))
      || !Array.isArray(article.sourceIds) || !article.sourceIds.length
      || !Array.isArray(article.origins) || !article.origins.length || !validAttachments(article.attachments)
      || (article.url && !safeURL(article.url))) throw new Error('學校公告欄位無效');
    seen.add(article.id);
    for (const id of article.sourceIds) {
      const source = sources.get(id);
      if (!source || !(source.schools || [source.school]).includes(school)
        || !config.categoryIds[source.name]) throw new Error('學校公告包含未知或其他學校來源');
    }
    if (new Set(article.origins.map(origin => origin.sourceId)).size !== new Set(article.sourceIds).size
      || article.origins.some(origin => !article.sourceIds.includes(origin.sourceId)
        || typeof origin.id !== 'string' || (origin.url && !safeURL(origin.url)) || !validAttachments(origin.attachments))) {
      throw new Error('公告原始來源資訊不完整');
    }
  }
}

export function hydrateSchoolData(config, data, version) {
  const sources = new Map(config.sources.map(source => [source.id, source]));
  const articles = data.articles.map(article => {
    const primary = sources.get(article.sourceIds[0]);
    return {...article, schools: [data.school], sourceId: primary.id, source: primary.name,
      sources: [...new Set(article.sourceIds.map(id => sources.get(id).name))], sourceUrl: primary.url,
      siteUrl: new URL(primary.url).origin,
      origins: article.origins.map(origin => ({...origin, source: sources.get(origin.sourceId).name,
        sourceUrl: sources.get(origin.sourceId).url, siteUrl: new URL(sources.get(origin.sourceId).url).origin})),
    };
  });
  return {
    ...data, articles, premerged: true,
    updatedAt: version.updatedAt, lastSuccessfulAt: version.lastSuccessfulAt,
    sourceStatus: (version.sourceStatus || []).filter(status => !status.schools || status.schools.includes(data.school)),
    errors: version.errors || [],
  };
}
