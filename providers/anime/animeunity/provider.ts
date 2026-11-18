/// <reference path="./onlinestream-provider.d.ts" />
/// <reference path="./core.d.ts" />

const DEFAULT_BASE_URL = "https://animeunity.cx";
const VIXCLOUD_ORIGIN = "https://vixcloud.cc";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SEARCH_PAGE_SIZE = 30;
const MAX_SEARCH_PAGES = 10;

type AnimeRecord = {
    id: string | number;
    slug: string;
    title?: string;
    title_it?: string;
    anilist_id?: number;
    variants?: { language: string }[];
};
type SearchResponse = { data: AnimeRecord[]; next_page_url?: string | null };
type EpisodeRecord = {
    id: string | number;
    number: string | number;
    seq_number_start?: number;
    videos?: { id: string | number; language: string; is_hidden?: boolean }[];
};
type EpisodeResponse = { episodes: EpisodeRecord[]; start: number; tab_size: number; total: number };
type AnimePage = { props?: { embedUrl?: string; video?: { id: string | number } } };
type MasterPlaylist = { url: string; params: { token: string; expires: string; asn?: string } };
type HlsStream = { quality: string; url: string };
type RequestHeaders = { [name: string]: string };

class Provider {
    private readonly apiBaseUrl = this.normalizeBaseUrl("{{baseUrl}}");

    getSettings(): Settings {
        return { episodeServers: ["Server1"], supportsDub: true };
    }

    async search(query: SearchOptions): Promise<SearchResult[]> {
        const isManualSearch = !query.media.startDate?.year;
        const titles = (isManualSearch
            ? [query.query]
            : [query.media.romajiTitle, query.media.englishTitle, query.query, ...query.media.synonyms]
        ).filter(Boolean) as string[];
        const smartSearch = $scannerUtils.buildSmartSearchTitles(titles);
        const records = await this.findAnimeRecords(
            this.buildSearchQueries([...smartSearch.titles, ...titles]),
            isManualSearch ? undefined : query.media.id,
        );
        const language = query.dub ? "ita" : "jpn";
        const filtered = records.filter(record => record.variants?.some(variant => variant.language === language));

        console.log(`AnimeUnity search: ${filtered.length} ${query.dub ? "dub" : "sub"} result(s)`);
        return filtered.map(record => ({
            id: `${record.id}-${record.slug}::${language}`,
            title: record.title ?? record.title_it ?? record.slug,
            url: `${this.apiBaseUrl}/anime/${record.id}-${record.slug}`,
            subOrDub: query.dub ? "dub" : "sub",
        }));
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const [animeKey, selectedLanguage] = id.split("::");
        const animeId = animeKey.split("-")[0];
        const language = selectedLanguage === "ita" ? "ita" : "jpn";
        const episodes: EpisodeDetails[] = [];
        let start = 1;

        while (true) {
            const page = await this.getApi<EpisodeResponse>(`api/anime/${animeId}/episodes?start=${start}`);
            for (const episode of page.episodes ?? []) {
                const video = episode.videos?.find(item => item.language === language && !item.is_hidden);
                if (video) episodes.push(this.toEpisode(episode, video.id, animeKey));
            }
            const nextStart = page.start + page.tab_size;
            if (!page.episodes?.length || nextStart <= start || nextStart > page.total) break;
            start = nextStart;
        }

        return episodes;
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        if (server !== "default" && server !== "Server1") {
            throw new Error(`Unknown AnimeUnity server: ${server}`);
        }
        const pageHtml = await this.getText(episode.url, "AnimeUnity episode");
        const pageData = LoadDoc(pageHtml)("[data-page]").attr("data-page");
        if (!pageData) throw new Error("AnimeUnity episode is missing Inertia page data");
        const page = JSON.parse(pageData) as AnimePage;
        const embedUrl = page.props?.embedUrl;
        if (!embedUrl || String(page.props?.video?.id) !== episode.id) {
            throw new Error("AnimeUnity episode is missing the requested video embed");
        }
        const embedHtml = await this.getText(embedUrl.trim(), "VixCloud embed");
        const playlistUrl = this.buildPlaylistUrl(this.parseMasterPlaylist(embedHtml), embedHtml);
        const playlistContent = await this.getText(playlistUrl, "VixCloud playlist");
        const videoSources = this.parseHlsPlaylist(playlistContent, playlistUrl).map(stream => ({
            quality: stream.quality, subtitles: [], type: "m3u8", url: stream.url,
        }));

        if (videoSources.length === 0) throw new Error("VixCloud playlist contains no playable streams");
        return {
            server: "Server1",
            headers: this.getVixCloudHeaders(embedUrl),
            videoSources,
        };
    }

    private buildSearchQueries(titles: string[]): string[] {
        const queries = new Set<string>();
        for (const title of titles) {
            for (const candidate of [$scannerUtils.sanitizeQuery(title), $scannerUtils.buildSearchQuery(title)]) {
                const sanitized = this.sanitizeTitle(candidate);
                if (sanitized) queries.add(sanitized);
            }
        }
        console.log(`AnimeUnity search queries: ${[...queries].join(", ")}`);
        return [...queries];
    }

    private async findAnimeRecords(queries: string[], anilistId?: number): Promise<AnimeRecord[]> {
        const records = new Map<string, AnimeRecord>();
        for (const title of queries) {
            for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
                const result = await this.searchPage(title, page);
                const pageRecords = result.data ?? [];
                pageRecords.forEach(record => records.set(`${record.id}-${record.slug}`, record));
                if (anilistId && pageRecords.some(record => record.anilist_id === anilistId)) {
                    return [...records.values()].filter(record => record.anilist_id === anilistId);
                }
                if (!result.next_page_url || pageRecords.length < SEARCH_PAGE_SIZE) break;
            }
        }
        const found = [...records.values()];
        return anilistId ? found.filter(record => record.anilist_id === anilistId) : found;
    }

    private async searchPage(title: string, page: number): Promise<SearchResponse> {
        const url = `${this.apiBaseUrl}/api/archive?query=${encodeURIComponent(title)}&page=${page}`;
        const response = await fetch(url, { headers: { "Accept": "application/json", "User-Agent": USER_AGENT } });
        if (!response.ok) throw new Error(`AnimeUnity search failed: ${response.status} ${response.statusText}`);
        return response.json();
    }

    private toEpisode(episode: EpisodeRecord, videoId: string | number, animeKey: string): EpisodeDetails {
        const number = Number(episode.number);
        return {
            id: String(videoId),
            number: Number.isFinite(number) ? number : episode.seq_number_start ?? 0,
            url: `${this.apiBaseUrl}/anime/${animeKey}/${videoId}`,
        };
    }

    private parseMasterPlaylist(html: string): MasterPlaylist {
        const playlistObject = this.extractAssignedObject(html, "window.masterPlaylist");
        const paramsObject = playlistObject && this.extractPropertyObject(playlistObject, "params");
        const url = playlistObject && this.extractStringProperty(playlistObject, "url");
        const token = paramsObject && this.extractStringProperty(paramsObject, "token");
        const expires = paramsObject && this.extractStringProperty(paramsObject, "expires");
        const asn = paramsObject && this.extractStringProperty(paramsObject, "asn");
        if (!url || !token || !expires) throw new Error("VixCloud embed is missing master playlist data");
        return { url, params: { token, expires, ...(asn ? { asn } : {}) } };
    }

    private buildPlaylistUrl(master: MasterPlaylist, html: string): string {
        const playlist = new URL(master.url);
        playlist.searchParams.set("token", master.params.token);
        playlist.searchParams.set("expires", master.params.expires);
        if (master.params.asn) playlist.searchParams.set("asn", master.params.asn);
        if (/window\.canPlayFHD\s*=\s*true\b/.test(html)) playlist.searchParams.set("h", "1");
        return playlist.toString();
    }

    private parseHlsPlaylist(content: string, playlistUrl: string): HlsStream[] {
        const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const streams: HlsStream[] = [];
        for (let index = 0; index < lines.length; index++) {
            if (!lines[index].startsWith("#EXT-X-STREAM-INF")) continue;
            const streamUrl = lines[index + 1];
            if (!streamUrl || streamUrl.startsWith("#")) continue;
            const resolution = lines[index].match(/RESOLUTION=\d+x(\d+)/)?.[1];
            streams.push({ quality: resolution ? `${resolution}p` : "auto", url: new URL(streamUrl, playlistUrl).toString() });
        }
        return streams.length > 0 || !content.includes("#EXTM3U") ? streams : [{ quality: "auto", url: playlistUrl }];
    }

    private extractAssignedObject(source: string, assignment: string): string | null {
        const assignmentIndex = source.indexOf(assignment);
        const openingBrace = assignmentIndex < 0 ? -1 : source.indexOf("{", assignmentIndex + assignment.length);
        return openingBrace < 0 ? null : this.extractBalancedObject(source, openingBrace);
    }

    private extractPropertyObject(source: string, property: string): string | null {
        const match = new RegExp(`(?:['"]?${property}['"]?)\\s*:`).exec(source);
        const openingBrace = match ? source.indexOf("{", match.index + match[0].length) : -1;
        return openingBrace < 0 ? null : this.extractBalancedObject(source, openingBrace);
    }

    private extractBalancedObject(source: string, start: number): string | null {
        let depth = 0, quote = "", escaped = false;
        for (let index = start; index < source.length; index++) {
            const character = source[index];
            if (quote) {
                if (escaped) escaped = false;
                else if (character === "\\") escaped = true;
                else if (character === quote) quote = "";
            } else if (character === "'" || character === '"') quote = character;
            else if (character === "{") depth++;
            else if (character === "}" && --depth === 0) return source.slice(start, index + 1);
        }
        return null;
    }

    private extractStringProperty(source: string, property: string): string | null {
        const match = new RegExp(`(?:['"]?${property}['"]?)\\s*:\\s*(['"])([\\s\\S]*?)\\1`).exec(source);
        return match ? match[2].replace(/\\u0026/g, "&").replace(/\\(['"])/g, "$1") : null;
    }

    private async getApi<T>(endpoint: string): Promise<T> {
        const response = await fetch(this.getApiUrl(endpoint), { headers: { "Accept": "application/json", "User-Agent": USER_AGENT } });
        if (!response.ok) throw new Error(`AnimeUnity request failed (${endpoint}): ${response.status} ${response.statusText}`);
        return response.json();
    }

    private getApiUrl(endpoint: string): string {
        return `${this.apiBaseUrl.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;
    }

    private normalizeBaseUrl(configured: string): string {
        const url = configured.startsWith("{{") ? DEFAULT_BASE_URL : configured.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
        return /^https?:\/\/(?:www\.)?animeunity\.(?:co|so|to|cx)$/i.test(url) ? DEFAULT_BASE_URL : url;
    }

    private getVixCloudHeaders(embedUrl: string): RequestHeaders {
        const origin = new URL(embedUrl).origin || VIXCLOUD_ORIGIN;
        return { "Origin": origin, "Referer": `${origin}/`, "User-Agent": USER_AGENT };
    }

    
    private async getText(url: string, label: string): Promise<string> {
        const hostname = new URL(url).hostname;
        const vixcloudHostname = new URL(VIXCLOUD_ORIGIN).hostname;

        const isVixCloud = hostname === vixcloudHostname ||
            hostname.endsWith(`.${vixcloudHostname}`);

        const response = await fetch(url, {
            headers: isVixCloud ? this.getVixCloudHeaders(url) : { "User-Agent": USER_AGENT },
        });

        if (!response.ok) {
            throw new Error(`${label} request failed: ${response.status} ${response.statusText}`);
        }

        return response.text();
    }

    private sanitizeTitle(title: string): string {
        return title.toLowerCase().split(/[\-_:]+/)[0].replace(/\s+/g, " ").trim();
    }
}
