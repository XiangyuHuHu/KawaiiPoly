/**
 * Airport reference points for the NOAA station named in the market rules.
 * City-center coordinates are not used: the settlement temperature is the airport reading.
 */
export const PLAN16_STATIONS = Object.freeze({
  nzwn: { name: 'Wellington', latitude: -41.3272, longitude: 174.8053 },
  rksi: { name: 'Seoul', latitude: 37.4602, longitude: 126.4407 },
  efhk: { name: 'Helsinki', latitude: 60.3172, longitude: 24.9633 },
  rkpk: { name: 'Busan', latitude: 35.1795, longitude: 128.9382 },
  kord: { name: 'Chicago', latitude: 41.9742, longitude: -87.9073 },
  zspd: { name: 'Shanghai', latitude: 31.1434, longitude: 121.8052 },
  lfpb: { name: 'Paris', latitude: 48.9694, longitude: 2.4414 },
  wsss: { name: 'Singapore', latitude: 1.3644, longitude: 103.9915 },
  zggg: { name: 'Guangzhou', latitude: 23.3924, longitude: 113.2988 },
  rjtt: { name: 'Tokyo', latitude: 35.5523, longitude: 139.7798 },
  kmia: { name: 'Miami', latitude: 25.7959, longitude: -80.287 },
  zuck: { name: 'Chongqing', latitude: 29.7192, longitude: 106.6417 },
  zuuu: { name: 'Chengdu', latitude: 30.5785, longitude: 103.9471 },
  eham: { name: 'Amsterdam', latitude: 52.3105, longitude: 4.7683 },
  klga: { name: 'New York', latitude: 40.7772, longitude: -73.8726 },
  kaus: { name: 'Austin', latitude: 30.1945, longitude: -97.6699 },
  katl: { name: 'Atlanta', latitude: 33.6367, longitude: -84.4281 },
  klax: { name: 'Los Angeles', latitude: 33.9425, longitude: -118.4081 },
  lemd: { name: 'Madrid', latitude: 40.4719, longitude: -3.5626 },
  wmkk: { name: 'Kuala Lumpur', latitude: 2.7456, longitude: 101.7099 },
  ltac: { name: 'Ankara', latitude: 40.1281, longitude: 32.9951 },
  epwa: { name: 'Warsaw', latitude: 52.1657, longitude: 20.9671 },
  zgsz: { name: 'Shenzhen', latitude: 22.6393, longitude: 113.8107 },
  zbaa: { name: 'Beijing', latitude: 40.0799, longitude: 116.6031 },
  mmmx: { name: 'Mexico City', latitude: 19.4363, longitude: -99.0721 },
  eddm: { name: 'Munich', latitude: 48.3538, longitude: 11.7861 },
  ksfo: { name: 'San Francisco', latitude: 37.6213, longitude: -122.379 },
  rpll: { name: 'Manila', latitude: 14.5086, longitude: 121.0198 },
  kdal: { name: 'Dallas', latitude: 32.8471, longitude: -96.8518 },
  ksea: { name: 'Seattle', latitude: 47.4502, longitude: -122.3088 },
  khou: { name: 'Houston', latitude: 29.6454, longitude: -95.2789 },
  eglc: { name: 'London', latitude: 51.5053, longitude: 0.0553 },
  uuww: { name: 'Moscow', latitude: 55.5915, longitude: 37.2615 },
  mpmg: { name: 'Panama City', latitude: 8.9733, longitude: -79.5556 },
  zsqd: { name: 'Qingdao', latitude: 36.362, longitude: 120.0881 },
  limc: { name: 'Milan', latitude: 45.6306, longitude: 8.7281 },
  vilk: { name: 'Lucknow', latitude: 26.7606, longitude: 80.8893 },
  opkc: { name: 'Karachi', latitude: 24.9065, longitude: 67.1608 },
  zhhh: { name: 'Wuhan', latitude: 30.7838, longitude: 114.2081 },
  kbkf: { name: 'Denver', latitude: 39.7017, longitude: -104.7518 },
  sbgr: { name: 'Sao Paulo', latitude: -23.4356, longitude: -46.4731 },
  oejn: { name: 'Jeddah', latitude: 21.6796, longitude: 39.1565 },
  cyyz: { name: 'Toronto', latitude: 43.6777, longitude: -79.6248 },
  llbg: { name: 'Tel Aviv', latitude: 32.0114, longitude: 34.8867 },
  fact: { name: 'Cape Town', latitude: -33.9648, longitude: 18.6017 },
  ltfm: { name: 'Istanbul', latitude: 41.2753, longitude: 28.7519 },
  hko: { name: 'Hong Kong', latitude: 22.3019, longitude: 114.1741 }
});

export function stationFromDescription(description = '') {
  const text = String(description || '');
  const site = text.match(/site=([a-z0-9]{4})/i);
  if (site) {
    const station = PLAN16_STATIONS[site[1].toLowerCase()];
    return station ? { icao: site[1].toLowerCase(), ...station } : null;
  }
  if (/Hong Kong Observatory/i.test(text)) {
    return { icao: 'hko', ...PLAN16_STATIONS.hko };
  }
  return null;
}
