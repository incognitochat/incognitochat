package directory

import (
	"context"
	"errors"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// The operator's emergency switches live in one settings item:
//
//	S#switches   S   uploadsPaused (BOOL), downloadsPaused (BOOL)
//
// Only a BOOL true pauses; a missing item or attribute, or any other value,
// means not paused. The attribute names are spelled out, unlike the rest of
// the table, because an operator may type them into the AWS CLI during an
// incident (docs/deployment.md, "Emergency switches"). The item is runtime
// data: the app and the operator write it, never Terraform or CI, and it
// says nothing about anyone.
const switchesPK = "S#switches"

// Switch names one of the emergency switches.
type Switch string

const (
	// SwitchUploads pauses uploads: no new upload URLs.
	SwitchUploads Switch = "uploads"
	// SwitchDownloads pauses downloads: no new download URLs.
	SwitchDownloads Switch = "downloads"
)

// switchAttrs are the item's attribute for each switch.
var switchAttrs = map[Switch]string{
	SwitchUploads:   "uploadsPaused",
	SwitchDownloads: "downloadsPaused",
}

// ErrUnknownSwitch is returned for a switch that doesn't exist.
var ErrUnknownSwitch = errors.New("directory: unknown switch")

// Switches are the emergency switches as stored.
type Switches struct {
	UploadsPaused   bool
	DownloadsPaused bool
}

// Switches reads the emergency switches. The api function reads them
// eventually consistent and keeps them for a while (api.SwitchesTTL);
// the admin screen reads them consistently.
func (s *Store) Switches(ctx context.Context, consistent bool) (Switches, error) {
	out, err := s.DB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      &s.Table,
		Key:            key(switchesPK, skSettings),
		ConsistentRead: aws.Bool(consistent),
	})
	if err != nil {
		return Switches{}, err
	}
	return switchesOf(out.Item), nil
}

// SetSwitch turns one switch on (paused) or off, leaving the other as it
// is, and returns both as they are now.
func (s *Store) SetSwitch(ctx context.Context, sw Switch, paused bool) (Switches, error) {
	attr, ok := switchAttrs[sw]
	if !ok {
		return Switches{}, ErrUnknownSwitch
	}
	out, err := s.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 &s.Table,
		Key:                       key(switchesPK, skSettings),
		UpdateExpression:          aws.String("SET #s = :p"),
		ExpressionAttributeNames:  map[string]string{"#s": attr},
		ExpressionAttributeValues: attrs{":p": &types.AttributeValueMemberBOOL{Value: paused}},
		ReturnValues:              types.ReturnValueAllNew,
	})
	if err != nil {
		return Switches{}, err
	}
	return switchesOf(out.Attributes), nil
}

func switchesOf(item map[string]types.AttributeValue) Switches {
	paused := func(sw Switch) bool {
		v, ok := item[switchAttrs[sw]].(*types.AttributeValueMemberBOOL)
		return ok && v.Value
	}
	return Switches{UploadsPaused: paused(SwitchUploads), DownloadsPaused: paused(SwitchDownloads)}
}
