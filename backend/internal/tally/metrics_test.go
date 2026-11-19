package tally_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/incognitochat/incognitochat/backend/internal/api"
	"github.com/incognitochat/incognitochat/backend/internal/httpapi"
	"github.com/incognitochat/incognitochat/backend/internal/tally"
)

// The metric filters in infra/metrics.tf read counts by name. A renamed
// route, status or error code would leave them reading nothing, and their
// alarms quiet for good, so every name they read must be one the api can
// log: a route of its router with a status it answers, or an error code
// one of its handlers writes.
func TestMetricFiltersReadNamesTheAPILogs(t *testing.T) {
	src, err := os.ReadFile("../../../infra/metrics.tf")
	if err != nil {
		t.Fatal(err)
	}
	tf := string(src)

	var routes, errs []string
	for _, m := range regexp.MustCompile(`count\s*=\s*"(routes|errors)\.([a-z0-9_]+)"`).FindAllStringSubmatch(tf, -1) {
		if m[1] == "routes" {
			routes = append(routes, m[2])
		} else {
			errs = append(errs, m[2])
		}
	}
	// limited_routes are read as routes.<route>_429.
	if !strings.Contains(tf, `count = "routes.${route}_429"`) {
		t.Fatal(`metrics.tf no longer reads limited_routes as "routes.${route}_429": update this test`)
	}
	list := regexp.MustCompile(`(?s)limited_routes\s*=\s*\[(.*?)\]`).FindStringSubmatch(tf)
	if list == nil {
		t.Fatal("no limited_routes in metrics.tf")
	}
	limited := regexp.MustCompile(`"([a-z0-9_]+)"`).FindAllStringSubmatch(list[1], -1)
	for _, m := range limited {
		routes = append(routes, m[1]+"_429")
	}
	if len(routes) < 3 || len(errs) < 3 || len(limited) < 3 {
		t.Fatalf("read too little from metrics.tf: routes %v, errors %v", routes, errs)
	}

	codes, statuses := apiAnswers(t)
	router := httpapi.NewRouter()
	(&api.Server{}).Routes(router)
	names := map[string]bool{}
	for _, pattern := range router.Patterns() {
		for _, status := range statuses {
			names[tally.RouteName(pattern, status)] = true
		}
	}
	for _, name := range routes {
		if !names[name] {
			t.Errorf("metrics.tf reads routes.%s, which no route and status of the api is named", name)
		}
	}
	for _, code := range errs {
		if !codes[code] {
			t.Errorf("metrics.tf reads errors.%s, which no api handler answers", code)
		}
	}
}

// apiAnswers reads the api package's source for the error codes its
// handlers write (httpapi.Error(status, "code"), or "error": "code" in a
// JSON answer) and the statuses it names (http.StatusXxx).
func apiAnswers(t *testing.T) (codes map[string]bool, statuses []int) {
	t.Helper()
	byName := map[string]int{}
	words := strings.NewReplacer(" ", "", "-", "", "'", "")
	for status := 100; status < 600; status++ {
		if text := http.StatusText(status); text != "" {
			byName["Status"+words.Replace(text)] = status
		}
	}
	files, err := filepath.Glob("../api/*.go")
	if err != nil {
		t.Fatal(err)
	}
	codes = map[string]bool{}
	seen := map[int]bool{}
	fset := token.NewFileSet()
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.CallExpr:
				if isSelector(n.Fun, "httpapi", "Error") && len(n.Args) == 2 {
					if code, ok := stringLit(n.Args[1]); ok {
						codes[code] = true
					}
				}
			case *ast.KeyValueExpr:
				if key, ok := stringLit(n.Key); ok && key == "error" {
					if code, ok := stringLit(n.Value); ok {
						codes[code] = true
					}
				}
			case *ast.SelectorExpr:
				if x, ok := n.X.(*ast.Ident); ok && x.Name == "http" {
					if status, ok := byName[n.Sel.Name]; ok && !seen[status] {
						seen[status] = true
						statuses = append(statuses, status)
					}
				}
			}
			return true
		})
	}
	if !codes["rate_limited"] || !seen[http.StatusOK] || !seen[http.StatusTooManyRequests] {
		t.Fatalf("read too little from the api's source: codes %v, statuses %v", codes, statuses)
	}
	return codes, statuses
}

func isSelector(e ast.Expr, pkg, name string) bool {
	sel, ok := e.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	x, ok := sel.X.(*ast.Ident)
	return ok && x.Name == pkg && sel.Sel.Name == name
}

func stringLit(e ast.Expr) (string, bool) {
	lit, ok := e.(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return "", false
	}
	s, err := strconv.Unquote(lit.Value)
	return s, err == nil
}
