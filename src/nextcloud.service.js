const axios = require('axios');
const fs = require('fs');

const NEXTCLOUD_URL =
  process.env.NEXTCLOUD_URL.replace(/\/$/, '');

const NEXTCLOUD_USERNAME =
  process.env.NEXTCLOUD_USERNAME;

const NEXTCLOUD_APP_PASSWORD =
  process.env.NEXTCLOUD_APP_PASSWORD;

const NEXTCLOUD_ADMIN_USER_ID =
  process.env.NEXTCLOUD_ADMIN_USER_ID;

const auth = {
  username: NEXTCLOUD_USERNAME,
  password: NEXTCLOUD_APP_PASSWORD,
};

const OCS_HEADERS = {
  'OCS-APIRequest': 'true',
  Accept: 'application/json',
};

const nextcloud = axios.create({
  baseURL: NEXTCLOUD_URL,
  auth,
  timeout: 120000,
});


function normalizeEmail(email) {
  return String(email)
    .trim()
    .toLowerCase();
}


/**
 * Search Nextcloud users by first name.
 */
async function searchUsers(searchTerm) {

  console.log('\n========================================');
  console.log('[NEXTCLOUD] SEARCH USERS');
  console.log('========================================');

  console.log('[SEARCH] Search term:', searchTerm);

  try {

    const response = await nextcloud.get(
      '/ocs/v1.php/cloud/users',
      {
        params: {
          search: searchTerm,
        },
        headers: OCS_HEADERS,
      }
    );

    console.log(
      '[SEARCH] HTTP:',
      response.status
    );

    const users =
      response.data?.ocs?.data?.users || [];

    console.log(
      '[SEARCH] Candidates:',
      users.length
    );

    console.log(
      '[SEARCH] IDs:',
      users
    );

    return [...new Set(users)];

  } catch (error) {

    console.error(
      '[SEARCH] FAILED:',
      error.message
    );

    if (error.response) {

      console.error(
        '[SEARCH] HTTP:',
        error.response.status
      );

      console.error(
        '[SEARCH] Response:',
        error.response.data
      );
    }

    throw error;
  }
}


/**
 * Get full Nextcloud user information.
 */
async function getUser(userId) {

  console.log('\n----------------------------------------');
  console.log('[USER] GET USER');
  console.log('----------------------------------------');

  console.log(
    '[USER] ID:',
    userId
  );

  try {

    const response = await nextcloud.get(
      `/ocs/v1.php/cloud/users/${encodeURIComponent(userId)}`,
      {
        headers: OCS_HEADERS,
      }
    );

    const ocs =
      response.data?.ocs;

    if (
      !ocs ||
      ocs.meta?.status !== 'ok'
    ) {

      throw new Error(
        ocs?.meta?.message ||
        `Unable to get user ${userId}`
      );
    }

    const user =
      ocs.data;

    console.log(
      '[USER] ID:',
      user.id
    );

    console.log(
      '[USER] Email:',
      user.email
    );

    console.log(
      '[USER] Display name:',
      user.displayname
    );

    return user;

  } catch (error) {

    console.error(
      '[USER] FAILED:',
      userId
    );

    console.error(
      '[USER] Error:',
      error.message
    );

    throw error;
  }
}


/**
 * Find a user using:
 *
 * email
 *   ↓
 * first name
 *   ↓
 * search users
 *   ↓
 * get every candidate
 *   ↓
 * exact email match
 */
async function findUserByEmail(email) {

  console.log('\n');
  console.log('========================================');
  console.log('[LOOKUP] FIND USER BY EMAIL');
  console.log('========================================');

  const requestedEmail =
    normalizeEmail(email);

  console.log(
    '[LOOKUP] Email:',
    requestedEmail
  );

  if (!requestedEmail.includes('@')) {
    throw new Error('Invalid email');
  }

  const localPart =
    requestedEmail.split('@')[0];

  console.log(
    '[LOOKUP] Local part:',
    localPart
  );

  /*
   * bereket.axum
   *
   * becomes:
   *
   * bereket
   */
  const firstName =
    localPart
      .split(/[._-]/)
      .filter(Boolean)[0];

  console.log(
    '[LOOKUP] First name:',
    firstName
  );

  const candidateIds =
    await searchUsers(firstName);

  if (!candidateIds.length) {

    console.warn(
      '[LOOKUP] No candidates found'
    );

    return null;
  }

  console.log(
    `[LOOKUP] Checking ${candidateIds.length} candidates`
  );

  for (
    let i = 0;
    i < candidateIds.length;
    i++
  ) {

    const candidateId =
      candidateIds[i];

    console.log('\n');
    console.log(
      `[LOOKUP] Candidate ${i + 1}/${candidateIds.length}`
    );

    try {

      const user =
        await getUser(candidateId);

      const candidateEmail =
        normalizeEmail(
          user.email || ''
        );

      console.log(
        '[LOOKUP] Requested:',
        requestedEmail
      );

      console.log(
        '[LOOKUP] Candidate:',
        candidateEmail
      );

      if (
        candidateEmail ===
        requestedEmail
      ) {

        console.log('\n');
        console.log(
          '****************************************'
        );

        console.log(
          '[LOOKUP] MATCH FOUND'
        );

        console.log(
          '[LOOKUP] ID:',
          user.id
        );

        console.log(
          '[LOOKUP] Email:',
          user.email
        );

        console.log(
          '[LOOKUP] Name:',
          user.displayname
        );

        console.log(
          '****************************************'
        );

        return user;
      }

    } catch (error) {

      console.warn(
        '[LOOKUP] Candidate failed:',
        candidateId
      );

      console.warn(
        '[LOOKUP] Reason:',
        error.message
      );
    }
  }

  console.warn(
    '[LOOKUP] No exact email match'
  );

  return null;
}


/**
 * Upload to the ADMIN/SERVICE account.
 */
async function uploadToAdmin(
  localFilePath,
  originalFileName
) {

  console.log('\n');
  console.log('========================================');
  console.log('[UPLOAD] UPLOAD TO ADMIN ACCOUNT');
  console.log('========================================');

  console.log(
    '[UPLOAD] Admin ID:',
    NEXTCLOUD_ADMIN_USER_ID
  );

  console.log(
    '[UPLOAD] Admin username:',
    NEXTCLOUD_USERNAME
  );

  if (!NEXTCLOUD_ADMIN_USER_ID) {

    throw new Error(
      'NEXTCLOUD_ADMIN_USER_ID is not configured'
    );
  }

  if (!fs.existsSync(localFilePath)) {

    throw new Error(
      `File does not exist: ${localFilePath}`
    );
  }

  const stats =
    fs.statSync(localFilePath);

  console.log(
    '[UPLOAD] Local file size:',
    stats.size
  );

  const remoteFileName =
    `${Date.now()}-${originalFileName}`;

  /*
   * IMPORTANT:
   *
   * We authenticate as NEXTCLOUD_USERNAME,
   * therefore the DAV namespace is the ADMIN account.
   */
  const davPath =
    `/remote.php/dav/files/${encodeURIComponent(
      NEXTCLOUD_ADMIN_USER_ID
    )}/${encodeURIComponent(
      remoteFileName
    )}`;

  console.log(
    '[UPLOAD] DAV path:',
    davPath
  );

  console.log(
    '[UPLOAD] Upload URL:',
    `${NEXTCLOUD_URL}${davPath}`
  );

  try {

    const stream =
      fs.createReadStream(localFilePath);

    const response =
      await nextcloud.put(
        davPath,
        stream,
        {
          headers: {
            'Content-Type':
              'application/octet-stream',

            'Content-Length':
              stats.size,
          },

          maxBodyLength:
            Infinity,

          maxContentLength:
            Infinity,
        }
      );

    console.log(
      '[UPLOAD] HTTP:',
      response.status
    );

    console.log(
      '[UPLOAD] SUCCESS'
    );

    return {
      remoteFileName,
      remotePath:
        `/${remoteFileName}`,
      status:
        response.status,
    };

  } catch (error) {

    console.error(
      '[UPLOAD] FAILED'
    );

    console.error(
      '[UPLOAD] Error:',
      error.message
    );

    if (error.response) {

      console.error(
        '[UPLOAD] HTTP:',
        error.response.status
      );

      console.error(
        '[UPLOAD] Response:',
        error.response.data
      );
    }

    throw error;
  }
}


/**
 * Share uploaded file with target user.
 *
 * user.id is the ID found by the email lookup.
 */
async function shareWithUser(
  remotePath,
  targetUserId
) {

  console.log('\n');
  console.log('========================================');
  console.log('[SHARE] SHARE FILE');
  console.log('========================================');

  console.log(
    '[SHARE] File:',
    remotePath
  );

  console.log(
    '[SHARE] Target user ID:',
    targetUserId
  );

  try {

    const body =
      new URLSearchParams({
        path: remotePath,
        shareType: '0',
        shareWith: targetUserId,

        /*
         * 31 = all permissions
         *
         * read    = 1
         * update  = 2
         * create  = 4
         * delete  = 8
         * share   = 16
         *
         * 1+2+4+8+16 = 31
         */
        permissions: '31',
      }).toString();

    console.log(
      '[SHARE] Request body:',
      body
    );

    const response =
      await nextcloud.post(
        '/ocs/v2.php/apps/files_sharing/api/v1/shares',
        body,
        {
          headers: {
            ...OCS_HEADERS,
            'Content-Type':
              'application/x-www-form-urlencoded',
          },
        }
      );

    console.log(
      '[SHARE] HTTP:',
      response.status
    );

    console.log(
      '[SHARE] Response:',
      JSON.stringify(
        response.data,
        null,
        2
      )
    );

    const ocs =
      response.data?.ocs;

    if (
      !ocs ||
      ocs.meta?.status !== 'ok'
    ) {

      throw new Error(
        ocs?.meta?.message ||
        'Share failed'
      );
    }

    console.log(
      '[SHARE] SUCCESS'
    );

    return ocs.data;

  } catch (error) {

    console.error(
      '[SHARE] FAILED'
    );

    console.error(
      '[SHARE] Error:',
      error.message
    );

    if (error.response) {

      console.error(
        '[SHARE] HTTP:',
        error.response.status
      );

      console.error(
        '[SHARE] Response:',
        error.response.data
      );
    }

    throw error;
  }    
}


module.exports = {
  findUserByEmail, 
  uploadToAdmin,
  shareWithUser,
}; 