#!/bin/bash

echo "🚨 FIXING: Cannot reach OAuth consent page"
echo "=========================================="
echo ""
echo "Step 1: Basic Google Cloud Console Setup"
echo "----------------------------------------"
echo "1. Go to: https://console.cloud.google.com/"
echo "2. Sign in with your Google account"
echo "3. Create a new project or select existing one"
echo ""

echo "Step 2: Enable Google Calendar API"
echo "----------------------------------"
echo "1. In Google Cloud Console, go to: APIs & Services → Library"
echo "2. Search for: 'Google Calendar API'"
echo "3. Click on 'Google Calendar API'"
echo "4. Click the blue 'ENABLE' button"
echo "5. Wait for it to be enabled (you'll see a green checkmark)"
echo ""

echo "Step 3: Create OAuth Credentials"
echo "--------------------------------"
echo "1. Go to: APIs & Services → Credentials"
echo "2. Click: '+ CREATE CREDENTIALS' → 'OAuth 2.0 Client IDs'"
echo "3. If prompted to configure OAuth consent screen, click 'CONFIGURE CONSENT SCREEN'"
echo ""

echo "Step 4: Configure OAuth Consent Screen (IMPORTANT)"
echo "---------------------------------------------------"
echo "1. Choose: 'External' (unless you have Google Workspace)"
echo "2. Fill in REQUIRED fields:"
echo "   • App name: 'My Calendar App' (or any name)"
echo "   • User support email: your-email@gmail.com"
echo "   • Developer contact information: your-email@gmail.com"
echo "3. Click 'SAVE AND CONTINUE'"
echo "4. On Scopes page: Click 'SAVE AND CONTINUE' (leave default)"
echo "5. On Test users page: Click 'ADD USERS' and add your Gmail address"
echo "6. Click 'SAVE AND CONTINUE'"
echo ""

echo "Step 5: Back to OAuth Credentials"
echo "---------------------------------"
echo "1. Go back to: APIs & Services → Credentials"
echo "2. Click: '+ CREATE CREDENTIALS' → 'OAuth 2.0 Client IDs'"
echo "3. Application type: 'Web application'"
echo "4. Name: 'Calendar Integration'"
echo "5. Authorized redirect URIs: Add this EXACT URL:"
echo "   http://localhost:3001/auth/google/callback"
echo "6. Click 'CREATE'"
echo "7. Copy the Client ID and Client Secret"
echo ""

echo "Step 6: Update Your .env File"
echo "-----------------------------"
echo "Update your .env file with the new credentials:"
echo "GOOGLE_CLIENT_ID=your-new-client-id"
echo "GOOGLE_CLIENT_SECRET=your-new-client-secret"
echo ""

echo "Step 7: Test the Integration"
echo "----------------------------"
echo "1. Save your .env file"
echo "2. Restart your application"
echo "3. Go to: http://localhost:3001/calendar"
echo "4. Click 'Connect Google Calendar'"
echo ""

echo "🔍 Quick Test:"
echo "Run this command to test your new setup:"
echo "node test-google-oauth.js"
echo ""

echo "❓ Still having issues?"
echo "Try this simplified test URL:"
echo "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:3001/auth/google/callback&scope=https://www.googleapis.com/auth/calendar.readonly"
echo ""
echo "Replace 'YOUR_CLIENT_ID' with your actual client ID from step 5."
