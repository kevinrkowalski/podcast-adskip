/// <reference types="jest" />
jest.mock('expo-constants', () => ({ __esModule: true, default: {} }));
jest.mock('@/src/db/storage', () => ({ DEFAULT_API_URL: 'http://192.168.0.124:8000' }));
import { isInsecureRemoteApiUrl } from './backend';

test('plain http to an internet host is flagged', () => {
  expect(isInsecureRemoteApiUrl('http://api.example.com')).toBe(true);
  expect(isInsecureRemoteApiUrl('HTTP://129.146.12.34:8000/')).toBe(true);
  expect(isInsecureRemoteApiUrl('http://172.32.0.1')).toBe(true);
});

test('https, the home network, this device and private VPNs are fine', () => {
  for (const url of [
    'https://api.example.com',
    'http://192.168.0.124:8000',
    'http://10.0.2.2:8000',
    'http://172.20.1.5',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'http://my-server.local',
    'http://100.101.102.103:8000',
    'http://box.tail1234.ts.net',
    'http://[::1]:8000',
    'http://[fd7a:115c:a1e0::1]:8000',
    '',
  ]) {
    expect(isInsecureRemoteApiUrl(url)).toBe(false);
  }
});
