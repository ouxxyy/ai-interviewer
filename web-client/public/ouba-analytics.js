/* Ouba analytics v1. Only anonymous, allowlisted events. */
(function () {
  'use strict';
  if (window.oubaAnalytics || location.hostname === 'horse.redboook.cn') return;
  const config = document.currentScript;
  const websiteId = config && config.dataset.websiteId;
  const domain = config && config.dataset.domain;
  if (!websiteId || !domain || location.hostname !== domain) return;
  const events = new Set(['contact_opened','wechat_copied','community_opened','community_link_copied','community_link_clicked','official_account_opened','official_account_copied','email_clicked','github_clicked','practice_requested','practice_started','practice_ended','practice_completed','arrangement_completed','story_requested','story_completed','story_followup_completed','chat_mode_selected','chat_requested','chat_completed','share_opened','signup_completed','purchase_completed']);
  const queue = [];
  const props = new Set(['placement','service','mode','completed_questions','total_questions','schema_version','value','currency','plan']);
  function cleanData(data) {
    const result = {schema_version: 1};
    Object.entries(data || {}).forEach(function (entry) {
      const key=entry[0], value=entry[1];
      if (!props.has(key)) return;
      if (typeof value==='number' && Number.isFinite(value) && value>=0 && value<=1000000) result[key]=value;
      else if (typeof value==='string' && /^[a-zA-Z0-9_-]{1,60}$/.test(value)) result[key]=value;
    });
    return result;
  }
  function cleanUrl(value, referrer) {
    if (!value) return '';
    try {
      const url=new URL(value,location.origin);
      if (referrer) return url.origin;
      const path=url.pathname.replace(/\/(session|report)\/[^/]+/g,'/$1/:id');
      const query=new URLSearchParams();
      ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'].forEach(function(key){const value=url.searchParams.get(key);if(value && /^[a-zA-Z0-9_-]{1,80}$/.test(value)) query.set(key,value);});
      return path+(query.size?'?'+query.toString():'');
    } catch (_) { return '/'; }
  }
  window.oubaBeforeSend=function(type,payload){
    if (payload.name && !events.has(payload.name)) return false;
    const result=Object.assign({},payload,{url:cleanUrl(payload.url,false),referrer:cleanUrl(payload.referrer,true),title:config.dataset.title || domain});
    if (payload.name) result.data=cleanData(payload.data);
    return result;
  };
  function send(name,data){try {const pending=window.umami.track(name,data);if(pending && pending.catch)pending.catch(function(){});}catch(_) {}}
  window.oubaAnalytics={track:function(name,data){
    if(!events.has(name))return;
    const safe=cleanData(data);
    if(window.umami)send(name,safe);
    else if(queue.length<50)queue.push([name,safe,Date.now()]);
  }};
  const script=document.createElement('script');
  script.src=(config.dataset.proxy==='same-origin'?location.origin+'/ouba-tracker.js':'https://stats.redboook.cn/script.js');script.async=true;
  if(config.dataset.proxy==='same-origin')script.dataset.hostUrl=location.origin+'/ouba-metrics';
  script.dataset.websiteId=websiteId;script.dataset.domains=domain;
  script.dataset.beforeSend='oubaBeforeSend';script.dataset.excludeHash='true';script.dataset.doNotTrack='true';
  if(new URLSearchParams(location.search).get('analytics_test')==='1')script.dataset.tag='validation';
  script.onload=function(){queue.splice(0).forEach(function(item){if(Date.now()-item[2]<30000)send(item[0],item[1]);});};
  script.onerror=function(){queue.length=0;};
  document.head.appendChild(script);
})();