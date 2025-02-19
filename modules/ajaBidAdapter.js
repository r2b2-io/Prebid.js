import {createTrackPixelHtml, logError, logWarn, deepAccess, getBidIdParameter} from '../src/utils.js';
import { Renderer } from '../src/Renderer.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { VIDEO, BANNER, NATIVE } from '../src/mediaTypes.js';
import {tryAppendQueryString} from '../libraries/urlUtils/urlUtils.js';

const BidderCode = 'aja';
const URL = 'https://ad.as.amanad.adtdp.com/v2/prebid';
const SDKType = 5;
const AdType = {
  Banner: 1,
  Native: 2,
  Video: 3,
};

const BannerSizeMap = {
  '970x250': 1,
  '300x250': 2,
  '320x50': 3,
  '728x90': 4,
  '320x100': 6,
  '336x280': 31,
  '300x600': 32,
}

export const spec = {
  code: BidderCode,
  supportedMediaTypes: [VIDEO, BANNER, NATIVE],

  /**
   * Determines whether or not the given bid has all the params needed to make a valid request.
   *
   * @param {BidRequest} bidRequest
   * @returns {boolean}
   */
  isBidRequestValid: function(bidRequest) {
    return !!(bidRequest.params.asi);
  },

  /**
   * Build the request to the Server which requests Bids for the given array of Requests.
   * Each BidRequest in the argument array is guaranteed to have passed the isBidRequestValid() test.
   *
   * @param {BidRequest[]} validBidRequests
   * @param {*} bidderRequest
   * @returns {ServerRequest|ServerRequest[]}
   */
  buildRequests: function(validBidRequests, bidderRequest) {
    const bidRequests = [];
    const pageUrl = bidderRequest?.refererInfo?.page || undefined;

    for (let i = 0, len = validBidRequests.length; i < len; i++) {
      const bidRequest = validBidRequests[i];
      let queryString = '';

      const asi = getBidIdParameter('asi', bidRequest.params);
      queryString = tryAppendQueryString(queryString, 'asi', asi);
      queryString = tryAppendQueryString(queryString, 'skt', SDKType);
      queryString = tryAppendQueryString(queryString, 'tid', bidRequest.ortb2Imp?.ext?.tid)
      queryString = tryAppendQueryString(queryString, 'prebid_id', bidRequest.bidId);
      queryString = tryAppendQueryString(queryString, 'prebid_ver', '$prebid.version$');

      if (pageUrl) {
        queryString = tryAppendQueryString(queryString, 'page_url', pageUrl);
      }

      const banner = deepAccess(bidRequest, `mediaTypes.${BANNER}`)
      if (banner) {
        const adFormatIDs = [];
        for (const size of banner.sizes || []) {
          if (size.length !== 2) {
            continue
          }

          const adFormatID = BannerSizeMap[`${size[0]}x${size[1]}`];
          if (adFormatID) {
            adFormatIDs.push(adFormatID);
          }
        }
        queryString = tryAppendQueryString(queryString, 'ad_format_ids', adFormatIDs.join(','));
      }

      const eids = bidRequest.userIdAsEids;
      if (eids && eids.length) {
        queryString = tryAppendQueryString(queryString, 'eids', JSON.stringify({
          'eids': eids,
        }));
      }

      const sua = deepAccess(bidRequest, 'ortb2.device.sua');
      if (sua) {
        queryString = tryAppendQueryString(queryString, 'sua', JSON.stringify(sua));
      }

      bidRequests.push({
        method: 'GET',
        url: URL,
        data: queryString
      });
    }

    return bidRequests;
  },

  interpretResponse: function(bidderResponse) {
    const bidderResponseBody = bidderResponse.body;

    if (!bidderResponseBody.is_ad_return) {
      return [];
    }

    const ad = bidderResponseBody.ad;

    const bid = {
      requestId: ad.prebid_id,
      cpm: ad.price,
      creativeId: ad.creative_id,
      dealId: ad.deal_id,
      currency: ad.currency || 'USD',
      netRevenue: true,
      ttl: 300, // 5 minutes
      meta: {
        advertiserDomains: []
      },
    }

    if (AdType.Video === ad.ad_type) {
      const videoAd = bidderResponseBody.ad.video;
      Object.assign(bid, {
        vastXml: videoAd.vtag,
        width: videoAd.w,
        height: videoAd.h,
        renderer: newRenderer(bidderResponseBody),
        adResponse: bidderResponseBody,
        mediaType: VIDEO
      });

      Array.prototype.push.apply(bid.meta.advertiserDomains, videoAd.adomain)
    } else if (AdType.Banner === ad.ad_type) {
      const bannerAd = bidderResponseBody.ad.banner;
      Object.assign(bid, {
        width: bannerAd.w,
        height: bannerAd.h,
        ad: bannerAd.tag,
        mediaType: BANNER
      });
      try {
        bannerAd.imps.forEach(impTracker => {
          const tracker = createTrackPixelHtml(impTracker);
          bid.ad += tracker;
        });
      } catch (error) {
        logError('Error appending tracking pixel', error);
      }

      Array.prototype.push.apply(bid.meta.advertiserDomains, bannerAd.adomain)
    } else if (AdType.Native === ad.ad_type) {
      const nativeAds = ad.native.template_and_ads.ads;
      if (nativeAds.length === 0) {
        return [];
      }

      const nativeAd = nativeAds[0];
      const assets = nativeAd.assets;

      Object.assign(bid, {
        mediaType: NATIVE
      });

      bid.native = {
        title: assets.title,
        body: assets.description,
        cta: assets.cta_text,
        sponsoredBy: assets.sponsor,
        clickUrl: assets.lp_link,
        impressionTrackers: nativeAd.imps,
        privacyLink: assets.adchoice_url
      };

      if (assets.img_main !== undefined) {
        bid.native.image = {
          url: assets.img_main,
          width: parseInt(assets.img_main_width, 10),
          height: parseInt(assets.img_main_height, 10)
        };
      }

      if (assets.img_icon !== undefined) {
        bid.native.icon = {
          url: assets.img_icon,
          width: parseInt(assets.img_icon_width, 10),
          height: parseInt(assets.img_icon_height, 10)
        };
      }

      Array.prototype.push.apply(bid.meta.advertiserDomains, nativeAd.adomain)
    }

    return [bid];
  },

  getUserSyncs: function(syncOptions, serverResponses) {
    const syncs = [];
    if (!serverResponses.length) {
      return syncs;
    }

    const bidderResponseBody = serverResponses[0].body;

    if (syncOptions.pixelEnabled && bidderResponseBody.syncs) {
      bidderResponseBody.syncs.forEach(sync => {
        syncs.push({
          type: 'image',
          url: sync
        });
      });
    }

    if (syncOptions.iframeEnabled && bidderResponseBody.sync_htmls) {
      bidderResponseBody.sync_htmls.forEach(sync => {
        syncs.push({
          type: 'iframe',
          url: sync
        });
      });
    }

    return syncs;
  },
}

function newRenderer(bidderResponse) {
  const renderer = Renderer.install({
    id: bidderResponse.ad.prebid_id,
    url: bidderResponse.ad.video.purl,
    loaded: false,
  });

  try {
    renderer.setRender(outstreamRender);
  } catch (err) {
    logWarn('Prebid Error calling setRender on newRenderer', err);
  }

  return renderer;
}

function outstreamRender(bid) {
  bid.renderer.push(() => {
    window['aja_vast_player'].init({
      vast_tag: bid.adResponse.ad.video.vtag,
      ad_unit_code: bid.adUnitCode, // target div id to render video
      width: bid.width,
      height: bid.height,
      progress: bid.adResponse.ad.video.progress,
      loop: bid.adResponse.ad.video.loop,
      inread: bid.adResponse.ad.video.inread
    });
  });
}

registerBidder(spec);
