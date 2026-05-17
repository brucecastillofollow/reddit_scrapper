/**
 * Static Reddit Listing API field maps (t3 = post, t1 = comment).
 * Unknown future keys are stored in `note` JSONB.
 */

const TS = 'timestamptz';
const TXT = 'text';
const INT = 'integer';
const BIGINT = 'bigint';
const BOOL = 'boolean';
const FLOAT = 'double precision';
const JSON = 'jsonb';

/** @type {Record<string, string>} */
export const POST_FIELD_TYPES = {
  approved_at_utc: TS,
  subreddit: TXT,
  selftext: TXT,
  author_fullname: TXT,
  saved: BOOL,
  mod_reason_title: TXT,
  gilded: INT,
  clicked: BOOL,
  is_gallery: BOOL,
  title: TXT,
  link_flair_richtext: JSON,
  subreddit_name_prefixed: TXT,
  hidden: BOOL,
  pwls: INT,
  link_flair_css_class: TXT,
  downs: INT,
  thumbnail_height: INT,
  top_awarded_type: TXT,
  hide_score: BOOL,
  media_metadata: JSON,
  quarantine: BOOL,
  link_flair_text_color: TXT,
  upvote_ratio: FLOAT,
  author_flair_background_color: TXT,
  ups: INT,
  domain: TXT,
  media_embed: JSON,
  thumbnail_width: INT,
  author_flair_template_id: TXT,
  is_original_content: BOOL,
  user_reports: JSON,
  secure_media: JSON,
  is_reddit_media_domain: BOOL,
  is_meta: BOOL,
  category: TXT,
  secure_media_embed: JSON,
  gallery_data: JSON,
  link_flair_text: TXT,
  can_mod_post: BOOL,
  score: INT,
  approved_by: TXT,
  is_created_from_ads_ui: BOOL,
  author_premium: BOOL,
  thumbnail: TXT,
  edited: TXT,
  author_flair_css_class: TXT,
  author_flair_richtext: JSON,
  gildings: JSON,
  content_categories: JSON,
  is_self: BOOL,
  subreddit_type: TXT,
  created: BIGINT,
  link_flair_type: TXT,
  wls: INT,
  removed_by_category: TXT,
  banned_by: TXT,
  author_flair_type: TXT,
  total_awards_received: INT,
  allow_live_comments: BOOL,
  selftext_html: TXT,
  likes: BOOL,
  suggested_sort: TXT,
  banned_at_utc: TS,
  url_overridden_by_dest: TXT,
  view_count: INT,
  archived: BOOL,
  no_follow: BOOL,
  is_crosspostable: BOOL,
  pinned: BOOL,
  over_18: BOOL,
  all_awardings: JSON,
  awarders: JSON,
  media_only: BOOL,
  link_flair_template_id: TXT,
  can_gild: BOOL,
  spoiler: BOOL,
  locked: BOOL,
  author_flair_text: TXT,
  treatment_tags: JSON,
  visited: BOOL,
  removed_by: TXT,
  mod_note: TXT,
  distinguished: TXT,
  subreddit_id: TXT,
  author_is_blocked: BOOL,
  mod_reason_by: TXT,
  num_reports: INT,
  removal_reason: TXT,
  link_flair_background_color: TXT,
  is_robot_indexable: BOOL,
  report_reasons: JSON,
  author: TXT,
  discussion_type: TXT,
  num_comments: INT,
  send_replies: BOOL,
  contest_mode: BOOL,
  mod_reports: JSON,
  author_patreon_flair: BOOL,
  author_flair_text_color: TXT,
  permalink: TXT,
  stickied: BOOL,
  url: TXT,
  subreddit_subscribers: INT,
  created_utc: TS,
  num_crossposts: INT,
  media: JSON,
  is_video: BOOL,
};

/** @type {Record<string, string>} */
export const COMMENT_FIELD_TYPES = {
  subreddit_id: TXT,
  approved_at_utc: TS,
  author_is_blocked: BOOL,
  comment_type: TXT,
  link_title: TXT,
  mod_reason_by: TXT,
  banned_by: TXT,
  ups: INT,
  num_reports: INT,
  author_flair_type: TXT,
  total_awards_received: INT,
  subreddit: TXT,
  link_author: TXT,
  likes: BOOL,
  replies: JSON,
  user_reports: JSON,
  saved: BOOL,
  banned_at_utc: TS,
  mod_reason_title: TXT,
  gilded: INT,
  archived: BOOL,
  collapsed_reason_code: TXT,
  no_follow: BOOL,
  author: TXT,
  num_comments: INT,
  can_mod_post: BOOL,
  send_replies: BOOL,
  parent_id: TXT,
  score: INT,
  author_fullname: TXT,
  over_18: BOOL,
  report_reasons: JSON,
  removal_reason: TXT,
  approved_by: TXT,
  controversiality: INT,
  body: TXT,
  edited: TXT,
  top_awarded_type: TXT,
  downs: INT,
  author_flair_css_class: TXT,
  is_submitter: BOOL,
  collapsed: BOOL,
  author_flair_richtext: JSON,
  author_patreon_flair: BOOL,
  body_html: TXT,
  gildings: JSON,
  collapsed_reason: TXT,
  distinguished: TXT,
  associated_award: JSON,
  stickied: BOOL,
  author_premium: BOOL,
  can_gild: BOOL,
  link_id: TXT,
  unrepliable_reason: TXT,
  author_flair_text_color: TXT,
  score_hidden: BOOL,
  permalink: TXT,
  subreddit_type: TXT,
  link_permalink: TXT,
  author_flair_template_id: TXT,
  subreddit_name_prefixed: TXT,
  author_flair_text: TXT,
  treatment_tags: JSON,
  created: BIGINT,
  created_utc: TS,
  awarders: JSON,
  all_awardings: JSON,
  locked: BOOL,
  author_flair_background_color: TXT,
  collapsed_because_crowd_control: BOOL,
  mod_reports: JSON,
  quarantine: BOOL,
  mod_note: TXT,
  link_url: TXT,
};

export const POST_COLUMNS = Object.keys(POST_FIELD_TYPES);
export const COMMENT_COLUMNS = Object.keys(COMMENT_FIELD_TYPES);

function coerce(value, sqlType) {
  if (value === null || value === undefined) return null;

  switch (sqlType) {
    case BOOL:
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      return Boolean(value);
    case INT:
      if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
      return parseInt(String(value), 10) || 0;
    case BIGINT:
      if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
      return parseInt(String(value), 10) || 0;
    case FLOAT:
      return typeof value === 'number' ? value : parseFloat(String(value)) || 0;
    case TS:
      if (typeof value === 'number') return new Date(value * 1000);
      if (typeof value === 'string' && value) return new Date(value);
      return null;
    case JSON:
      if (value === '' || value === null) return null;
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return { _raw: value };
        }
      }
      return value;
    case TXT:
      if (typeof value === 'object') return JSON.stringify(value);
      if (typeof value === 'boolean') return String(value);
      return String(value);
    default:
      return value;
  }
}

function buildNote(data, knownKeys) {
  const note = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'id' || key === 'name') continue;
    if (!knownKeys.has(key)) note[key] = value;
  }
  return Object.keys(note).length > 0 ? note : null;
}

export function rowFromRedditPost(data) {
  const known = new Set(POST_COLUMNS);
  const row = {
    data_id: String(data.id),
    fullname: data.name || `t3_${data.id}`,
    note: buildNote(data, known),
  };

  for (const key of POST_COLUMNS) {
    if (data[key] !== undefined) row[key] = coerce(data[key], POST_FIELD_TYPES[key]);
  }

  if (!row.created_utc && data.created_utc != null) {
    row.created_utc = coerce(data.created_utc, TS);
  } else if (!row.created_utc && data.created != null) {
    row.created_utc = coerce(data.created, TS);
  }
  if (!row.subreddit) row.subreddit = '';
  if (!row.created_utc) row.created_utc = new Date();

  return row;
}

export function rowFromRedditComment(data) {
  const known = new Set(COMMENT_COLUMNS);
  const row = {
    data_id: String(data.id),
    fullname: data.name || `t1_${data.id}`,
    note: buildNote(data, known),
  };

  for (const key of COMMENT_COLUMNS) {
    if (data[key] !== undefined) row[key] = coerce(data[key], COMMENT_FIELD_TYPES[key]);
  }

  if (!row.created_utc && data.created_utc != null) {
    row.created_utc = coerce(data.created_utc, TS);
  } else if (!row.created_utc && data.created != null) {
    row.created_utc = coerce(data.created, TS);
  }
  if (!row.subreddit) row.subreddit = '';
  if (!row.created_utc) row.created_utc = new Date();

  return row;
}

export function buildCreateTableSql(tableName, fieldTypes, { primaryKey = 'data_id' } = {}) {
  const lines = [
    `${primaryKey} VARCHAR(20) PRIMARY KEY`,
    'fullname VARCHAR(24) UNIQUE NOT NULL',
    'updated_at TIMESTAMPTZ DEFAULT NOW()',
    'note JSONB',
  ];

  for (const [name, type] of Object.entries(fieldTypes)) {
    const required = name === 'created_utc' || name === 'subreddit';
    lines.push(`${name} ${type}${required ? ' NOT NULL' : ''}`);
  }

  return `CREATE TABLE ${tableName} (\n  ${lines.join(',\n  ')}\n);`;
}

export function buildPostsSchemaSql() {
  return `
DROP TABLE IF EXISTS posts CASCADE;
${buildCreateTableSql('posts', POST_FIELD_TYPES)}
CREATE INDEX ix_posts_subreddit ON posts (subreddit);
CREATE INDEX ix_posts_created ON posts (created_utc);
`;
}

export function buildCommentsSchemaSql() {
  return `
DROP TABLE IF EXISTS comments CASCADE;
${buildCreateTableSql('comments', COMMENT_FIELD_TYPES)}
CREATE INDEX ix_comments_subreddit ON comments (subreddit);
CREATE INDEX ix_comments_created ON comments (created_utc);
`;
}
