/**
 * Parse YouTube search results from ytInitialData.
 *
 * The relevant path inside ytInitialData:
 *   contents
 *     .twoColumnSearchResultsRenderer
 *     .primaryContents
 *     .sectionListRenderer
 *     .contents[]          ← one per result section
 *     .itemSectionRenderer
 *     .contents[]          ← one per result (videoRenderer, channelRenderer, etc.)
 */

export function parseSearchResults(initialData) {
  if (!initialData) return [];

  const sections =
    initialData
      ?.contents
      ?.twoColumnSearchResultsRenderer
      ?.primaryContents
      ?.sectionListRenderer
      ?.contents ?? [];

  const results = [];

  for (const section of sections) {
    const items = section?.itemSectionRenderer?.contents ?? [];
    for (const item of items) {
      const vr = item.videoRenderer;
      if (!vr) continue;

      const video = parseVideoRenderer(vr);
      if (video) results.push(video);
    }
  }

  return results;
}

function parseVideoRenderer(vr) {
  const videoId = vr.videoId;
  if (!videoId) return null;

  const title =
    vr.title?.runs?.[0]?.text ||
    vr.title?.simpleText ||
    '';

  const author =
    vr.ownerText?.runs?.[0]?.text ||
    vr.shortBylineText?.runs?.[0]?.text ||
    '';

  const duration =
    vr.lengthText?.simpleText ||        // "4:32"
    vr.lengthText?.accessibility?.accessibilityData?.label || // "4 minutes, 32 seconds"
    '';

  const viewCount =
    vr.viewCountText?.simpleText ||
    vr.viewCountText?.runs?.map(r => r.text).join('') ||
    '';

  const thumbnails = vr.thumbnail?.thumbnails ?? [];
  const thumbnail  = thumbnails[thumbnails.length - 1]?.url ?? '';

  const publishedText =
    vr.publishedTimeText?.simpleText || '';

  const isLive = !!vr.badges?.some(b =>
    b.metadataBadgeRenderer?.label === 'LIVE'
  );

  return {
    videoId,
    title,
    author,
    duration,         // human-readable string, e.g. "4:32"
    viewCount,
    publishedText,
    thumbnail,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    isLive,
  };
}

/**
 * Parse the "continuation" token for loading more results (if needed).
 */
export function parseContinuationToken(initialData) {
  const sections =
    initialData
      ?.contents
      ?.twoColumnSearchResultsRenderer
      ?.primaryContents
      ?.sectionListRenderer
      ?.contents ?? [];

  for (const section of sections) {
    const token =
      section?.continuationItemRenderer?.continuationEndpoint
        ?.continuationCommand?.token;
    if (token) return token;
  }
  return null;
}
