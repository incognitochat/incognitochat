package directory

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

func TestSwitches(t *testing.T) {
	s, client := store(t)
	ctx := context.Background()
	read := func() Switches {
		t.Helper()
		sw, err := s.Switches(ctx, true)
		if err != nil {
			t.Fatal(err)
		}
		return sw
	}

	// No item: nothing paused.
	if sw := read(); sw != (Switches{}) {
		t.Fatalf("no item: %+v", sw)
	}
	// One at a time, the other left as it is.
	if sw, err := s.SetSwitch(ctx, SwitchUploads, true); err != nil || sw != (Switches{UploadsPaused: true}) {
		t.Fatalf("pause uploads = %+v, %v", sw, err)
	}
	if sw, err := s.SetSwitch(ctx, SwitchDownloads, true); err != nil || sw != (Switches{UploadsPaused: true, DownloadsPaused: true}) {
		t.Fatalf("pause downloads = %+v, %v", sw, err)
	}
	if sw, err := s.SetSwitch(ctx, SwitchUploads, false); err != nil || sw != (Switches{DownloadsPaused: true}) {
		t.Fatalf("resume uploads = %+v, %v", sw, err)
	}
	if sw := read(); sw != (Switches{DownloadsPaused: true}) {
		t.Fatalf("read = %+v", sw)
	}
	if _, err := s.SetSwitch(ctx, "sends", true); !errors.Is(err, ErrUnknownSwitch) {
		t.Fatalf("unknown switch: %v", err)
	}

	// What the runbook's AWS CLI commands write (docs/deployment.md).
	if _, err := client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &s.Table,
		Key:                       map[string]types.AttributeValue{"pk": sv("S#switches"), "sk": sv("S")},
		UpdateExpression:          aws.String("SET uploadsPaused = :p"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":p": &types.AttributeValueMemberBOOL{Value: true}},
	}); err != nil {
		t.Fatal(err)
	}
	if sw := read(); sw != (Switches{UploadsPaused: true, DownloadsPaused: true}) {
		t.Fatalf("after update-item: %+v", sw)
	}
	// Only a BOOL true pauses: a value of another type is not paused, and
	// is reported.
	if _, err := client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &s.Table,
		Item: map[string]types.AttributeValue{
			"pk": sv("S#switches"), "sk": sv("S"),
			"uploadsPaused": sv("true"), "downloadsPaused": &types.AttributeValueMemberBOOL{Value: false},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if sw := read(); sw != (Switches{Malformed: true}) {
		t.Fatalf("not BOOL true: %+v", sw)
	}
}
