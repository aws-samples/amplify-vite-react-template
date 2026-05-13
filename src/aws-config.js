import { Amplify } from 'aws-amplify';

Amplify.configure({
    Auth: {
        region: 'eu-north-1',
        userPoolId: 'eu-north-1_XXXXX', // From your Cognito setup
        userPoolWebClientId: 'XXXXX',
    },
    API: {
        aws_appsync_graphqlEndpoint: 'https://xxxxxx.appsync-api.eu-north-1.amazonaws.com/graphql',
        aws_appsync_region: 'eu-north-1',
        aws_appsync_authenticationType: 'AMAZON_COGNITO_USER_POOLS',
    },
    Storage: {
        AWSS3: {
            bucket: 'bofelo-driver-docs-bucket',
            region: 'eu-north-1',
        }
    }
});

