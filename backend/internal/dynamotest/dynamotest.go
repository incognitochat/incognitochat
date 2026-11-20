// Package dynamotest runs store tests against DynamoDB Local.
//
// Tests using it are skipped unless DYNAMODB_ENDPOINT is set (CI sets it and
// DYNAMODB_REQUIRED, which turns the skip into a failure). Locally:
//
//	podman run --rm -p 8000:8000 docker.io/amazon/dynamodb-local:3.3.2
//	DYNAMODB_ENDPOINT=http://localhost:8000 go test ./...
package dynamotest

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/incognitochat/incognitochat/backend/internal/ids"
)

// Client returns a client for DynamoDB Local, or skips the test.
func Client(t *testing.T) *dynamodb.Client {
	t.Helper()
	endpoint := os.Getenv("DYNAMODB_ENDPOINT")
	if endpoint == "" {
		if os.Getenv("DYNAMODB_REQUIRED") != "" {
			t.Fatal("DYNAMODB_REQUIRED is set but DYNAMODB_ENDPOINT is not")
		}
		t.Skip("set DYNAMODB_ENDPOINT to run against DynamoDB Local")
	}
	return dynamodb.New(dynamodb.Options{
		Region:       "us-east-1",
		BaseEndpoint: aws.String(endpoint),
		Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
			return aws.Credentials{AccessKeyID: "local", SecretAccessKey: "local"}, nil
		}),
	})
}

// Table creates a table shaped like the real ones (pk/sk strings) and
// deletes it when the test ends.
func Table(t *testing.T, client *dynamodb.Client) string {
	t.Helper()
	return table(t, client, false)
}

// DirectoryTable is Table with the directory's index of account items by
// their last-use month, as infra/tables.tf makes it: "lastUse", hash key
// sk, range key lu, keys only (backend/internal/directory, expiry.go).
func DirectoryTable(t *testing.T, client *dynamodb.Client) string {
	t.Helper()
	return table(t, client, true)
}

func table(t *testing.T, client *dynamodb.Client, lastUse bool) string {
	t.Helper()
	ctx := context.Background()
	name := "test-" + ids.New()
	in := &dynamodb.CreateTableInput{
		TableName:   &name,
		BillingMode: types.BillingModePayPerRequest,
		AttributeDefinitions: []types.AttributeDefinition{
			{AttributeName: aws.String("pk"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("sk"), AttributeType: types.ScalarAttributeTypeS},
		},
		KeySchema: []types.KeySchemaElement{
			{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash},
			{AttributeName: aws.String("sk"), KeyType: types.KeyTypeRange},
		},
	}
	if lastUse {
		in.AttributeDefinitions = append(in.AttributeDefinitions,
			types.AttributeDefinition{AttributeName: aws.String("lu"), AttributeType: types.ScalarAttributeTypeS})
		in.GlobalSecondaryIndexes = []types.GlobalSecondaryIndex{{
			IndexName: aws.String("lastUse"),
			KeySchema: []types.KeySchemaElement{
				{AttributeName: aws.String("sk"), KeyType: types.KeyTypeHash},
				{AttributeName: aws.String("lu"), KeyType: types.KeyTypeRange},
			},
			Projection: &types.Projection{ProjectionType: types.ProjectionTypeKeysOnly},
		}}
	}
	_, err := client.CreateTable(ctx, in)
	if err != nil {
		t.Fatalf("create table: %v", err)
	}
	waiter := dynamodb.NewTableExistsWaiter(client)
	if err := waiter.Wait(ctx, &dynamodb.DescribeTableInput{TableName: &name}, 30*time.Second); err != nil {
		t.Fatalf("wait for table: %v", err)
	}
	t.Cleanup(func() {
		_, _ = client.DeleteTable(context.Background(), &dynamodb.DeleteTableInput{TableName: &name})
	})
	return name
}
