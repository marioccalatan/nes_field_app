# NES Field App

Android companion app for the NES project.

## First run

```bash
npm install
npm run android
```

The default API base URL is `http://10.0.2.2:4000`, which works for the Android emulator when the NES API is running on the same Windows machine.

For a physical Android phone, start the API so it is reachable from your local network, then run Expo with:

```bash
$env:EXPO_PUBLIC_API_BASE_URL="http://YOUR_LAPTOP_IP:4000"
npm run android
```
