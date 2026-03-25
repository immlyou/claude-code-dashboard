// Firebase Configuration
// 請到 Firebase Console 建立專案後，將 config 貼到這裡
// https://console.firebase.google.com/

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  appId: "YOUR_APP_ID"
};

// 設定步驟：
// 1. 前往 https://console.firebase.google.com/
// 2. 建立新專案 (例如: claude-dashboard-leaderboard)
// 3. 在專案設定中找到 "Your apps" > 新增網頁應用程式
// 4. 複製 firebaseConfig 到上方
// 5. 在 Build > Realtime Database 啟用資料庫 (選擇 test mode)
// 6. 在 Build > Authentication > Sign-in method 啟用 "Anonymous"

window.FIREBASE_CONFIG = firebaseConfig;
